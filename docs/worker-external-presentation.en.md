<a id="工作者外部呈现合同-10"></a>
# Worker external presentation contract 1.0

[简体中文](worker-external-presentation.md) · **English**


This optional contract connects an external-frame Worker to exact clone-time
scheduling facts and a genuine final presentation acknowledgement. It is a
transport boundary; enabling it does not install the page scheduler or prove a
CanvasKit/GPU, browser, platform or performance gate.

Recoverable external surface loss uses the separate opt-in
[Worker surface recovery 1.0](worker-surface-recovery.en.md) contract. It revokes
native input lifetime before retained reuse or a required normal render, while
preserving the Worker/session; a fresh surface still requires its genuine ACK.

<a id="显式协商"></a>
## Explicit negotiation

A caller must opt in on its load request:

```js
const loaded = await worker.requestHost('load', {
  renderer: 'external-frame',
  externalPresentation: { version: '1.0' },
})
```

An explicit manifest/force renderer policy can also select external-frame. The
requested transport must resolve to external-frame. Browser-view selection is
rejected with `ERR_UNSUPPORTED_CAPABILITY`.

Before loading the manifest or entering `app.init`, the Worker requires these
host exports:

- `external_presentation_contract_json()`
- `last_frame_input_json(revision)`
- `render_target_json(revision)`
- `acknowledge_presentation_outcome_json(revision)`

The first export is pure: it does not create a session, enter application JS or
allocate a surface. Its exact descriptor is:

```json
{"version":"1.0","consumedInput":"1.0","ackOutcome":"1.0","physicalTarget":"1.0"}
```

Missing exports, an unsupported request or an old descriptor fail with
`ERR_PROTOCOL_VERSION`; no fallback or application-code probe establishes the
contract. The negotiated load response adds `externalPresentation` with this
descriptor. Without the request option, load/frame/ACK response shapes remain
legacy-compatible, and the Worker does not probe the optional exports.

<a id="克隆时帧事实"></a>
## Clone-time frame facts

The opt-in `frame` and `frame.current` results retain their existing frame,
renderRevision, viewRevision and optional batch fields. They also carry:

```js
scheduling: {
  version: '1.0',
  sessionId: '...',
  renderRevision: '...',
  consumedInput: {
    pageId: '...',
    routePath: 'pages/home/index',
    templateRevision: '...',
    viewport: { x: 0, y: 0, width: 375, height: 667 },
  }, // or null
}
```

This metadata comes only from `last_frame_input_json` for the exact render
revision read with that frame, before ACK. It never comes from current/latest
state, a ready hook or an ACK-time template revision. Null stays null. Manual
frames, explicit-data renders and retired proofs cannot claim generated-page
input. Template input can legitimately be older than latest state after
attached/ready/observer effects.

A density repaint can publish a new render token while retaining the same
consumed input. It does not evaluate the View again. Stale revision access is
rejected. Canonical decimal strings preserve the complete u64 domain; do not
coerce them to Number. Geometry is compared against the frame's direct f32 JSON
values, not independently rounded DOM geometry. Product scheduling requires
finite positive logical dimensions no larger than 4096, even where the legacy
low-level external renderer accepts an empty target.

`copyExternalFrameScheduling` in `worker-runtime.mjs` validates, independently
copies and freezes these fields. Worker structured clone does not preserve
Object.freeze: a page receiver must invoke the helper again before admitting the
result to a scheduler. The helper does not copy a whole render frame.

<a id="与修订绑定的物理目标"></a>
## Revision-bound physical target

Opt-in `frame` and `frame.current` additionally carry `target`:

```js
{ version: '1.0', sessionId: '...', renderRevision: '...', width: 750, height: 1334 }
```

The pure native `render_target_json(revision)` export reads the accepted frame
and render scale on the same owned runtime turn and rejects stale revisions.
It performs no pixel readback or View evaluation. It never derives dimensions
from a later device `pixelRatio` or latest metrics. Changing density produces a
new publication revision; an invalid density retains the previous publication
and target. The logical viewport in scheduling proof remains unchanged.

`copyExternalFrameTarget` is the receiver-side validation/copy helper. Invoke it
again after structured clone. It requires the exact session/render token,
positive integer dimensions at most 4096 per edge, and at most 16 MiB RGBA-equivalent
surface allocation. Empty legacy low-level frames do not satisfy this product
presentation contract. This bound does not itself prove actual GPU allocation
or successful display.

<a id="真正的最终确认回执"></a>
## Genuine final ACK

The opt-in `ack` request is unchanged:

```js
const final = await worker.requestHost('ack', {
  renderRevision: prepared.renderRevision,
})
```

Its new final is separate from the legacy BridgeBatch API:

```js
{
  version: '1.0',
  sessionId: '...',
  renderRevision: '...',
  acknowledged: true,
  inputEnabled: false,
  requiresRestart: false,
  batch: { messages: [/* complete native effects and diagnostics */] },
  observedState: {/* pure native runtime_state_json result */},
}
```

The new native/WASM `acknowledge_presentation_outcome_json` calls the actual
runtime ACK. Neither a queued HTTP/RPC receipt nor a fake empty batch is a final
ACK. The entire returned effects/error batch is preserved, including committed
ready failures, navigation effects and bounded-turn faults. Duplicate ACKs return
their genuine new empty batch; prior effects are never replayed.

There is deliberately no `consumedInput` or `scheduling` in this final. ACK can
observe the latest templateRevision as diagnostic state, but must not update or
relabel prepare-time proof.

Rust alone can prove `inputEnabled: true`. All of these must remain valid after
the actual ACK:

- The requested revision is the current presented render revision.
- The same nonempty page identity/path existed before and after this ACK.
- Lifecycle is Active, execution is healthy, and the exact frame-input proof is
  still within its original page/viewport/preview lifetime.
- This revision's ACK has not produced an ordinary error or restart effect.

`is_current_frame_presented` alone is insufficient: duplicate ACKs can return
before owner checks, and ordinary ready errors need not fault the engine. A
sticky block is therefore recorded for the exact publication revision, including
when the legacy ACK entry point was used first. Empty duplicate ACKs cannot clear
it. A genuinely new publication revision may be reconsidered against the same
healthy/runtime-proof gates; a retained density repaint is a new publication but
is not evidence of new View evaluation. A successful manifest load resets the
record, while a failed load preserves the running host's record.

No comparison with latest templateRevision is an input gate: ordinary ready
setData creates a later render demand but does not invalidate the already
published frame's input authority. Hide/show, logical resize, preview retirement,
page departure/return and execution faults retire proof and cannot revive input
on an old ACK. Native engine fault or a new route requiring WebView requests a
restart. Policy-driven transport changes stay distinct from engine faults.

The Worker validates the genuine final and applies explicit renderer policy to
its actual observedState. It can suppress input for policy/owner failure but
cannot synthesize permission. It observes a batch directly instead of doing a
JSON stringify/parse round trip, preserving numeric -0 and nested diagnostics.
If metadata validation fails after irreversible ACK, the error details preserve
the available real batch and observedState rather than pretending rollback. A
malformed JSON string cannot provide recoverable structured diagnostics.

`copyExternalPresentationOutcome` validates, independently copies and recursively
freezes a final. A receiving page must call it after structured clone. Both
receiver helpers perform bounded plain-data measurement before reading supplied
fields, reject enumerable accessors without invoking them, and use the existing
16 MiB/node/depth transport budget. Frame pixel/asset transfer is unchanged.

<a id="接收端集成和证据限制"></a>
## Receiver integration and evidence limits

Example boundary usage (not an installed product adapter):

```js
import {
  copyExternalFrameScheduling,
  copyExternalFrameTarget,
  copyExternalPresentationOutcome,
} from './worker-runtime.mjs'

const frame = await worker.requestHost('frame', {})
const scheduling = copyExternalFrameScheduling(frame.scheduling, {
  sessionId: worker.sessionId,
  renderRevision: frame.renderRevision,
  frame: frame.frame,
})
const target = copyExternalFrameTarget(frame.target, {
  sessionId: worker.sessionId, renderRevision: frame.renderRevision,
})
// The owning presenter submits these exact frame commands at target size before ACK.
const wireFinal = await worker.requestHost('ack', { renderRevision: frame.renderRevision })
const final = copyExternalPresentationOutcome(wireFinal, {
  sessionId: worker.sessionId,
  renderRevision: frame.renderRevision,
})
// Admit scheduling and final to a scheduler only within its unchanged hard fence.
```

This change supplies wire boundaries and authored tests. It does not integrate a
page external presenter, replace the running simulator, install phased DOM
presentation, or show that any performance gate passed. Native real-engine tests
and fake-host Worker protocol tests are separate: the fake does not prove Rust,
WASM, browser or GPU behavior. Root integration must run native/Node/WASM checks
and real owned-browser presentation/race tests before reporting acceptance.
