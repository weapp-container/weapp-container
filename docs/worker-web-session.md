# WorkerWebSession owner

This async owner is used by the static Worker product entry alongside the legacy
sync embedding API. Automatic browser development watch remains disabled until
the trusted bootstrap, manager and exact close chain are integrated. Execution
evidence is bound to specific source revisions; module availability alone does
not establish browser, GPU, performance or seven-host conformance.

```js
const session = new WorkerWebSession({
  surfaceRoot,
  onBatch(batch) { /* synchronous diagnostics/effects */ },
  onState(status) { /* runtime and presentation readiness are distinct */ },
  onError(error) { /* replace the owner explicitly when required */ },
})
await session.load({
  workerUrl: './runtime-worker.mjs',
  indexUrl: './pack-index.json', indexSha256,
  engine: 'quickjs', renderer: 'auto', rendererPolicy: { mode: 'manifest' },
  viewport: { width: 375, height: 667 },
  rendererAssets, // full pinned runtime-config schema, only used externally
})
const actualFinal = await session.request('api.call', payload)
await session.setLogicalViewport({ width: 667, height: 375 })
await session.setRenderScale(2) // external-frame only; no View evaluation
await session.setVisible(false)
await session.close()
```

`load` reports successful verified runtime startup. Its return includes actual
scheduler status, not a claim of pixels, input readiness or GPU completion.
`status.presentation` and `status.inputEnabled` expose current presentation
state. There is no synchronous runtime handle, public raw Worker/RPC getter,
main-thread application WASM import, native HTTP session or fallback branch.
The actual defaults are WorkerRpcClient, WorkerBridgeTransport,
PresentationScheduler, WorkerDomAdapter, WorkerCanvasKitAdapter and
attachSurfaceInput. V8/software requests explicitly fail at this stage.

Trusted embedders may set `viewExecution: { batchTimeoutMs: 250 }` on `load`.
The Worker accepts only an integer from 1 to 5000 ms; omission preserves the
native 50 ms batch default. This allowance covers the isolated View realm and
is still shortened by the active AppService turn and bridge deadline. It does
not extend `engineExecution.turnTimeoutMs` (default 250 ms), the separate
bootstrap budget, or the absolute load deadline. Keep these product settings
in host code; guest data and URL query parameters cannot change them.

## Admission and ownership

One `load` call claims the owner before any await, creates one fresh Worker and
one bridge, and returns the same load Promise on repeats. A separate manager
must await old owner close before executing a replacement. The separate
`BrowserDevOwnerManager` implements that local ordering; browser development
CLI/bootstrap integration and automatic renderer-family replacement remain
separate gates.

`admitPack` defaults to `admitWorkerPack` from worker-admission-loader.mjs. Its
precise injected contract is:

```js
admitPack({ indexUrl, indexSha256, indexSize?, route?, rendererPolicy, signal })
// -> version 1.0, resolved route, rendererPolicy, transportBackend,
//    declaredProfile, effectiveProfile,
//    provenance { indexSha256, manifestSha256, integrityRoot }, manifest?
```

It must verify the pinned index/manifest, route and policy without executing any
application. The Worker independently verifies the same pins. Preflight selects
whether the load request may opt into `externalPresentation`; actual load pins,
backend, declared/effective profile, route, real QuickJS and negotiated contracts
must all agree. Mismatch closes this exact owner; it never retries another
renderer/engine or claims prior application effects rolled back.

`loadRendererAssets` defaults to `loadPinnedCanvasKit` and runs only for an
admitted actual external-frame load:

```js
loadRendererAssets({ owner, loadResult, rendererAssets, signal })
// -> { version:'1.0', owner, CanvasKit, fontData:ArrayBuffer,
//      presenterOptions?, dispose() /* stable actual last-use barrier */ }
```

The loader verifies the existing six pinned renderer resources. It must own and
clean partial failures and settle on abort. The owner validates the returned
identity, adopts a late returned lease before checking cancellation, and disposes
it after adapter last use. The loader's page-scoped drawing WASM cache is distinct
from application execution and per-owner font ownership; one owner closing does
not claim to destroy a shared CanvasKit module. The builder package descriptor
correction is a separate required candidate, not silently repaired by this owner.

Optional factory injection supplies the same named RPC/bridge/scheduler/adapter
contracts for Node drafts or explicit embedding. Factories must self-clean when
throwing before transferring ownership, and any async factory must settle after
abort. No resource-using callback may schedule work beyond its last-use barrier.

## Ordered observations before effects

The bridge and both adapters borrow one observed RPC facade, which has the exact
immutable epoch/session identity and no close/terminate method. It consumes the
original outer observation on success, wire errors and late finals before
returning that result/error/envelope to the actual consumer. It never makes a
page-side observation sequence or duplicates ordinary bridge response receives.

An older/same observation cannot overwrite current state. Equal original
sequences can legitimately accompany separate timer batches; event receipt IDs
deduplicate actual events, while every independent genuine batch still reaches
the unique bridge once. One newest observation and 32 diagnostics are retained;
no unbounded startup event log is buffered. Consumer callbacks are synchronous;
the event callback never awaits RAF, presentation/resources or another RPC.

This candidate requires the accompanying producer contract:

- startup batch payload: `phase:'startup'`, no observation, only before the
  initial ordered load observation;
- live batch payload: `phase:'live'`, with the original same-turn observation;
- dirty payload: the original complete observation.

Older producers without this contract are incompatible. Missing/bad live metadata freezes
and faults first, then preserves the real batch for its actual consumer. It does
not relabel an older snapshot or replay a turn to manufacture ordering.

Reserved timer faults may instead carry bounded diagnostic committedResult data
with `effectDelivery:'unconfirmed'` and an explicitly omitted observation. This
owner freezes and reports their original nested error/details. Diagnostic data
is never replayed as new bridge effects or treated as a presentation/ACK.

Native success remains actual success when its observation requires a renderer
replacement. The page owner freezes/faults and exposes the actual committed
navigation final; it does not convert that final into rollback or execute it
again. A finally-refresh error can retain an actual raw bridge/metrics result.
For a failed bridge/view.abort outer call, the owner preserves the real retained
batch in its fact/diagnostic sink without correlating its success into the still
pending inner request; the original outer error must reject that request. Direct
metrics/retire results have no such pending inner correlation. Frame/ACK retained effects belong to the CanvasKit adapter's
error consumer, avoiding duplicate batch delivery. Normal view.retire control
results also reach the owner's effects sink; cleanup RPC remains available.

## Presentation, metrics and input

The actual adapter/scheduler perform all preparation proof, publication and ACK
checks. The owner wraps scheduler contexts with its own live/visible/local metrics revision gate, so a
continuation cannot enable input after owner failure, including a successful
native ACK delivered with a faulty observation. Ordinary render failure can be
retried with `retryPresentation`; a fatal owner fault needs explicit replacement.

DOM borrows the one bridge; its DomSessionClient owns real DOM input/geometry and
the phased transaction. The owner feeds adapter.receiveObservation before
scheduler observation and unique bridge batch ingress. It does not call
adapter.receiveEvent, pass adapter.onBatch, create a second transport or attach a
second DOM input helper. Unsupported retained DOM paint stays explicit.

CanvasKit surface installation resets/disposes its previous owned input helper,
then attaches the new helper before ACK/input enable. Coordinates always use
the authoritative logical viewport and surfaceGeneration, not physical canvas
width. Real adapter input authority and current owner/page/viewport/lifecycle
gate input; receipts and scheduler status alone cannot authorize it.
The session sizes its owned canvas CSS box from the installed proof's logical
viewport, independently of the physical backing store. Embedders apply display
zoom to the borrowed outer surface root, rather than changing render density.

`setWindowMetrics` accepts the full native shape, including simulated pixelRatio,
screen size, status/screen top, orientation and optional safeArea. Logical resize
builds on that device metrics profile; render density never overwrites its
pixelRatio. Metrics and lifecycle commands serialize on an owner control lane.
Pending metrics install a durable local revision before any queue or callback.
They synchronously reset CanvasKit contacts, invalidate the DOM client's actual
local authority, freeze its presenter, and suspend the scheduler without changing
a native observation or surfaceGeneration. The shared send boundary gates
`event.batch`, `view.events` and `view.geometry`; DOM input also checks the exact
accepted native key and current local authority. Presentation/ACK/cleanup
operations retain their separate channels.

Each prepared attempt captures the same owner revision through present/release.
Only the latest successful metrics final may reopen preparation, never input.
Scheduler resume keeps accepted empty and requests a real publication, including
for a same-value/no-op metrics operation. The matching genuine enabled
presentation final closes that revision's input fence. Earlier queued completions,
queue-counter cleanup, HTTP/RPC receipts and stale ACKs cannot close it. No-op
metrics deliberately obtain one new template publication; physical scale remains
the retained-paint path and does not invoke this logical metrics transaction.

DOM local authority revision is a separate monotonic client cancellation token;
native surfaceGeneration still comes solely from the original Worker state.
Strict confirmation publishes its stable Promise and records a real ACK as a
disabled confirmed candidate synchronously, before awaiting predecessor last-use.
Its final activation and every later geometry/event entry recheck the durable
input guard. An ordinarily retired real ACK remains retained with input disabled;
it is not converted into a resource cleanup error or a fabricated successful
current presentation. Genuine cleanup errors and timeouts still fail.

Native hard generations also retire actual keyed authority. A failed
metrics callback can already have committed dimensions; its final observation
is retained and the owner conservatively requires replacement, never restoring
old coordinates merely because the Promise rejected.

Hide revokes local input before dispatch. Show uses the genuine native lifecycle
and must get a real applicable publication/input result. Visibilitychange and
pagehide listeners are owned and removed on close. Browser page teardown may
prevent graceful async completion; explicit close is the reviewable barrier.

## Stable close and remaining gates

The same close Promise is published before abort/freeze hooks can reenter. It:

1. retires local input, aborts owned load/public waits and removes owned listeners;
2. waits the underlying load task so a late lease/adapter is owned and cleaned
   (it does not await the public load Promise that can itself await close);
3. closes the scheduler, including adapter cancellation/exact remote retirement,
   in-flight release and adapter disposal while RPC/bridge are still available;
4. releases owned input helpers and renderer leases after actual last use;
5. disposes the bridge, awaits exact RPC close/termination, settles queued owner
   controls and removes only its dedicated child mount.

Original faults and cleanup failures survive; later steps still run after an
earlier cleanup error. A remote transport failure cannot prove successful
runtime unload merely because local surfaces were disposed. No global Worker,
browser, process or user-root cleanup is used.

The actual close result now has `version: '1.0'`, immutable `owner` and captured
`rpcIdentity: {workerEpoch, sessionId}` alongside `closed`, `workerClosed`,
`ownedMountRemoved` and `workerFinal`. Identity fields are explicitly null when
not allocated; a created RPC can exist before pack admission establishes an
owner tuple. A cancelled admitted load preserves its tuple even when no public
runtime-ready result was returned. These cases still mean a constructed session
closed through its real barrier, never a `never-constructed` outcome.

The development manager validates the actual result against its original site
and every locally known tuple before reporting browser-reported close. Rust
uses a typed shape for this receipt; shape validation alone grants no disposal
authority. The development HTTP owner continues to deny successful close
reports until the trusted bootstrap and exact actual manager chain are wired.

The Node contracts use controlled RPC/adapter/scheduler work plus the actual
bridge and manager. The close-identity slice runs session, manager and HTTP
client contracts together; those contracts do not execute an actual Worker,
browser, presenter or GPU. Historical static Worker evidence is recorded
separately in [implementation status](dual-renderer/implementation-status.md).
Required development gates still include trusted bootstrap with the actual
manager/Worker close chain, retained site replacement, browser race/input/close
evidence and real input-to-present timing. This slice establishes neither
performance nor seven-host completion.


### 完整表面与宿主布局

`setWindowMetrics()` 的 `windowWidth/windowHeight` 描述实际渲染 View 的完整逻辑尺寸。
保留背景和画布的完整覆盖，在页面内部为可点击控件及滚动内容应用安全布局；不要先用安全区裁小画布。
可选 `hostLayout` 为容器扩展，结构如下：

```js
await session.setWindowMetrics({
  ...actualWindowMetrics,
  hostLayout: {
    version: 1,
    safeInsets: { top: 0, right: 84, bottom: 34, left: 0 },
    verticalBarEdge: 'right',
    reservedRegions: [
      { id: 'camera', kind: 'occlusion', x: 867, y: 0, width: 84, height: 56 },
    ],
  },
})
```

示例数值用于说明字段，生产值必须来自当前 View 的系统观测。`verticalBarEdge` 是宿主解析后的物理边缘；
`reservedRegions` 仅包含当前有效区域，坐标与边距均为 View 局部逻辑单位，框已包含系统提供的 margins。
完全展开时应移除无效折叠分隔。旧 `safeArea` 仍使用屏幕固定坐标，不能直接作为当前 View 的 padding。
省略 `hostLayout` 会清除旧布局；`setLogicalViewport()` 在改变尺寸时也会清除无法重新观测的局部布局。

页面使用 `wx.getWindowInfo().hostLayout` 同步读取，并通过
`wx.onHostLayoutChange(callback)` / `wx.offHostLayoutChange(callback)` 订阅和移除通知。
这两个 API 是容器扩展，必须在 manifest 与受限策略中明确声明。
通知参数为 `{ hostLayout }`；清除时值为 `null`。
只改变侧栏或保留区域时会撤销旧触摸和呈现权限，提交同步查询值，再通知页面；不会触发 `onResize`。
尺寸变化仍通过现有 `onResize` / `wx.onWindowResize` 通知。

`status.windowMetrics` 是只读、递归冻结的最近成功提交快照；它不代表新画面已经可交互。
等待本次 `status.metricsFence.revision` 对应的 `phase === 'open'`、新的呈现回执和
`status.inputEnabled === true` 后再解除宿主操作锁。旧请求的完成结果不能解除新请求的锁。

### Full surface and host layout

`windowWidth/windowHeight` cover the complete rendering View. Keep the background and canvas full size,
and protect content and controls using optional version-1 `hostLayout`. Its insets and active reserved-region
frames use View-local logical coordinates; margins are already included. `verticalBarEdge` is a resolved
physical `left`, `right`, or `none`, independent of language direction. Legacy `safeArea` keeps its fixed-screen
coordinate meaning. Omitting `hostLayout` clears it; a size-only `setLogicalViewport()` clears local layout
when the size changes because it cannot remeasure the host.

The container extension `wx.getWindowInfo().hostLayout` exposes the committed value.
Declare `wx.onHostLayoutChange` and `wx.offHostLayoutChange` in the manifest and restricted policy before
subscribing. A callback receives `{ hostLayout }`, with `null` when cleared. Layout-only changes retire old
touch/presentation authority without emitting a resize. The immutable `status.windowMetrics` snapshot is
available after a successful metrics final; interaction additionally requires a fresh presentation and the
matching `status.metricsFence.revision` to be open, with `status.inputEnabled === true`.
