<a id="canvasanimation-与-mediaqueryobserver-实现范围"></a>
# Canvas, Animation and MediaQueryObserver Implementation Scope

[简体中文](canvas-animation-media-query-scope.md) · **English**


This batch retains the fixed scope of WeChat base library 3.17.3, `miniprogram-api-typings@5.2.3`, and 1265 APIs across seven platforms, totaling 8855 cells. Source implementation, limited engine tests, installed artifacts, public SDK integration, device acceptance, and merchant acceptance are recorded separately. APIs with incomplete parameter or lifecycle coverage are not promoted to available.

<a id="画布"></a>
## Canvas

QuickJS/V8 installs the command facade from the same `container-core/src/canvas.js`. Command parameters are copied into finite primitive values/arrays before enqueueing; cycles, accessors, non-finite numbers, and unsupported objects are explicitly rejected and do not fall back to the generic clone of the original object. Each context can have up to 16384 pending commands to be submitted, estimating 4 MiB of parameter payload; a single command is limited to 65536 values and 8-level arrays. The payload estimation does not represent the total memory limit of the JS engine. After successful enqueue, the command prefix is consumed before consumption of the command; in case of synchronous enqueue failure, the prefix is retained for explicit retry; `reserve` retains only renderer history and does not re-submit old commands. Nested draw commands are rejected during enqueue, and the tail command of newly recorded entries is deferred to the next draw. A draw failure does not trigger a success callback.

The `getContext('2d')` of the same OffscreenCanvas reuses an object with a command queue. It remains a limited interface of existing batched CanvasFrame, lacking standard immediate drawing or full OffscreenCanvas semantics.

Native Skia uses a real PathEffect for `setLineDash`, with explicit filtering result checks for strokeRect/path, rejecting complexity without silently turning into solid lines; dashed strokeText is explicitly rejected, while regular strokeText shares the same configuration as other strokes. Text alignment uses actual font advances and metrics and participates in save/restore. The full batch is first pre-validated, then allocates a native surface, accesses fonts, and executes. Overflow in interval, period, and native count is explicitly rejected; execution failure does not publish new history or pixels. Software dash handles pixel projection and period boundary bisection within the canvas, no longer enumerating over potentially extremely numerous intervals; work per line segment is constrained by canvas size. Known compound limitations are pre-checked before surface allocation or font access; font installation is locked only when native drawing and readback succeed and publication is imminent, with the first rejected drawing remaining installable, and existing successful owners not being unlocked.

The following gaps still prevent full availability: Canvas page/component owner namespace and retirement,
the component parameter in `createCanvasContext`, resize clearing pixels and drawing state, complete drawing properties,
images/gradients/shadows/clipping, Path2D and Canvas factory, semantic of mixed transform path, complete font shaping.
Skia's hanging/ideographic usage approximates ascent/descent conventions, with the font BASE table not implemented;
software text remains limited, native execution does not imply multi-end physical presentation acceptance.

<a id="动画"></a>
## Animation

Dual engines share `animation.js`. Complete the optional translate parameter default value; step first finishes options
read and validate, then submit actions, getter errors are not dropped from the queue; reject re-entry modifications during options reading.
export hands over an independent queue and clears residual entries not in step. Parameters accept only primitive values allowed by fixed types,
set explicit resource limits of 16384 operations and 4096 steps, release quotas after export.

runtime/renderer has not consumed the animation property and is playing back according to the real frame clock. All Animation methods and `wx.createAnimation` continue partial, not treating the exportable animation queue as visible animation.

## MediaQueryObserver

The observer/callback and complete desired state of a Session are located in a shared private registry, bound to the real Page/Component incarnation via pageToken. The dual engine retrieves a monotonically increasing revision and a complete subscription snapshot from the receiver transport retained during bootstrap; after native full validation, it performs an atomic replacement. Public APIs such as api.call, observer alias, notification functions, and effect queue cannot register, revoke, or deliver these private subscriptions.
A regular Session and a trusted navigation mirror each maintain their own private current-page array. The portable global factory reads the actual current Page independently, without relying on mutable getCurrentPages or public arrays.

Fixed catalog contains only `object:MediaQueryObserver.observe` and `disconnect`, without portability
`wx.createMediaQueryObserver`; no denominator increase in this batch. Descriptor only reads width, height, minWidth, maxWidth, minHeight, maxHeight, and orientation, seven fields, each read once via captured Reflect.get, supports inheritance and getter. Unknown fields, cycles, and toJSON do not enter snapshot; after reading, revalidate owner/disconnect, reject re-entry of the same observer's descriptor.
Current value strategy accepts limited non-negative numbers, orientation is portrait/landscape; min/max include equality.

`disconnect` has a fixed signature with no parameters and returns void. It synchronously disables the observer and clears the private callback,
and is idempotent; each pending callback is validated for active status, owner/page token, and subscription identity.
Thus, disconnect from the previous callback, disconnect in the getter, dispose, terminal app unload, and poll retry after failure cannot recover callbacks that have been revoked. On the native side, resource cleanup occurs upon the next resource fetch, without waiting for a native ACK. Only the seven-end core implementation of this method is promoted to available, while public SDK acceptance remains pending.

`observe` continue partial: The official fixed type does not specify a non-negative constraint for the six number fields; negative values are currently rejected
Cannot claim complete numeric domain compatibility; repeated observe retains independent subscriptions, and observe is disallowed after disconnect;
however, the semantics for fixed version replacement/reuse remain undefined. Owner is retained to disposal, square dimensions are processed as portrait;
the timing and direction of fixed version notifications for these implementation strategies still require clarification.
Initial and match changes are asynchronously triggered by the real host page's logic dimensions, and the current strategy test is not considered the official oracle.

Private delivery reuses retained lifecycle dispatcher; each callback obtains an independent `{matches}`,
Ordinary callback errors enter the existing diagnostic channel and do not block other observers. notify records retry debt before a potentially failing fetch;
Successful media state is submitted prior to subsequent intersection delivery to avoid loss of notifications or replay of already-successful media callbacks. There are explicit upper limits of 1024 observed observers, 4096 subscriptions, and u64 sequence numbers.
A separate engine retains historical public diagnostic paths, which are not considered evidence of Session owner integrity.

<a id="产物与验收"></a>
## Outputs and Acceptance

This batch of new shared JS is embedded into the QuickJS/V8 runtime by the production AppService bootstrap. The old SDK, archive, preview lock, and historical browser evidence do not automatically include these changes and must retain the original source binding.
The installation artifacts, public SDK, physical devices, and merchant acceptance status for this batch are as evidenced in the corresponding freeze records; the scope remains pending without new evidence, and accepted status does not change due to passing source code tests.

The subsequent product `c058896f43e346f0c300bcbc6f6ab92ceea33466` has implemented Canvas owner/stroke/page redraw transactions, adding 28 partial and 0 available incremental attributes; final results for stage 47 and actual macOS Metal results along with Web build boundaries are available in [New Scope](canvas-owned-stroke-scope.en.md) and [Evidence](../archived-evidence.en.md). Early "not executed/not integrated" statements pertain to the status of their respective batches and do not cover the subsequent precise product conclusions.
