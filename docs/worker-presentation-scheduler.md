# Worker presentation scheduler

This pure module has no product entry-point import and does not implement a
Worker, RPC, DOM presenter, CanvasKit surface or runtime wire. Deterministic Node
tests cover its injected adapter contract. Product integration and actual
browser, GPU, performance and near-parity gates remain separate requirements.

## Scope and explicit integration blockers

`PresentationScheduler` admits one phased presentation at a time. It coalesces
ordinary dirty observations into one newest demand and owns at most one RAF.
It never evaluates JS, fetches a frame, calls an HTTP endpoint or selects another
engine/renderer itself. The adapter supplies the real transaction.

The following prerequisites are still required before a product can use it:

- Worker `frame`/`frame.current` must negotiate and return the exact revision's
  clone-time consumed input. A null/manual/detached frame is insufficient.
  The optional external-presentation wire now supplies that exact-revision
  metadata; its presence still does not install an actual presenter adapter.
- External ACK needs a genuine final `{ acknowledged, renderRevision,
  inputEnabled, requiresRestart, batch }` contract. A bridge batch, event ACK,
  queued receipt, local submit or latest runtime state cannot stand in for it.
- `DomSessionClient` now exposes strict `prepareTemplate`, `presentPrepared` and
  `releasePrepared` phases. The product adapter must use those phases directly,
  never call the compatibility `present()` and manufacture proof afterward.
  The scheduler must freeze proof before DOM publication/ACK.
- The opt-in ordered Worker observation lane now supplies the logical
  `surfaceGeneration`, tied to native input lifetime. The product owner must
  preserve that exact value for DOM requests and input-coordinate lifetime.
- The opt-in ordered lane provides canonical sequences; the product integration
  must retain them. A stale RPC response cannot receive a new sequence on the
  page merely because it arrived later.
- Renderer-policy negotiation, restart-required behavior, resource authorization,
  density transactions and close of the actual Worker remain the owner's work.
  Pure contract tests do not establish actual product ownership or presentation.

## Public API

```js
const scheduler = new PresentationScheduler({
  owner: { workerEpoch, sessionId, packSha256, transportBackend },
  adapter, requestFrame, cancelFrame, onError, onState,
})
scheduler.observe({ sequence: '1', state })
scheduler.retry() // explicit retry only after a blocked attempt
const status = scheduler.status
const closing = scheduler.close() // every call returns this same promise
```

Owner identity is immutable. `transportBackend` is `browser-view` or
`external-frame`; `packSha256` is lowercase SHA-256. A session/pack replacement
needs a new scheduler after the old owner finishes closing. The scheduler has no
main-thread WASM or software/HTTP fallback.

A demand state contains this exact scheduling subset:

```js
{
  owner,
  currentPage: { pageId: '1', path: 'pages/index/index' }, // or null
  templateRevision: '5', renderRevision: '8', viewRevision: '12',
  surfaceGeneration: '1',
  viewport: { x: 0, y: 0, width: 375, height: 667 },
  rendererProfile: 'skia', // skyline-compat or webview
  lifecycle: 'Active',    // Created, Background or Destroyed
}
```

All u64 IDs/revisions/sequences use canonical decimal strings and BigInt
comparison. `viewRevision` is validated if present and then discarded. It is
activity accounting, never a command to rerun WXML/WXS/modern View. Older or
equal observation sequences are ignored. Regressing revisions within a logical
lifetime fault the scheduler and freeze input. Invalid owner/shape is rejected.

The page ID/path, logical viewport, effective renderer, lifecycle and logical
surface generation form a hard input boundary. Its change synchronously freezes
input, cancels owned RAF and signals the flight to abort. Old candidates must be
released before a successor starts. Inactive/no-page states do not render. A
transport-family mismatch permanently requires a new owner; no silent renderer
switch or session restart occurs.

Injected functions can synchronously reenter `observe`, `retry` or `close`.
The new authoritative observation and complete retire/final/fault transition
are installed before notification code runs. Retirement captures the old RAF
and flight, never whichever resources a nested callback might later create.
Nested observations may advance newest demand, but cannot admit a successor
until the captured old RAF cancellation/flight abort barrier has returned. An
outer observation cannot restore its earlier demand after a nested observation.

Pure density and CSS display zoom must not change that logical generation.
Density is coordinated on the owner lane, produces a real retained-frame paint
revision when needed, and uses `preparePaint`, preserving consumed template input.
Display zoom is browser presentation and need not observe a new demand at all.
If a future physical surface API needs a separate epoch, it must preserve this
distinction; do not simulate density by invalidating template input here.

## Adapter phases and proof

Every adapter method is required, even where a backend rejects an unsupported
phase. The scheduler calls:

1. `prepareTemplate(demand, context)` for first/changed template or logical input;
   `preparePaint(demand, accepted, context)` for a newer retained external paint.
2. Validate/copy/freeze `candidate.proof`, then await an owned RAF.
3. `present(candidate, { ...context, proof, timestamp })` for the exact transaction.
4. `release(candidate, { owner, attemptId, proof, committed, retired })` exactly
   once for every returned candidate, including malformed or late results.

The Worker CanvasKit owner selects `preparationScheduling: 'microtask'`: newest
observations coalesce within a turn, asynchronous frame preparation starts before
RAF, and only the visible installation waits for RAF. The generic default remains
`'frame'`. A pending preparation token uses the same retirement slot as an
admission RAF (`status.hasRaf` also covers this queued admission), but has no
browser handle to cancel. Close, resize and navigation invalidate that exact
token and still drain a started flight before its successor.

CanvasKit preparation submits only the detached back buffer and validates its
local receipt. It cannot swap the visible canvas, ACK a revision or enable input.
`present` installs the already submitted buffer on RAF and then awaits the exact
runtime ACK. A failed or retired preparation releases its detached resources;
the displayed front buffer stays intact.

Context has immutable owner/attempt/surface identities, AbortSignal and
`isCurrent()`. The adapter must check current ownership before every irreversible
publish, ACK, input-enable or installation of decoded resources. Observations and
`onState`/`onError` callbacks must consume promptly and must not await rendering
from the Worker event-credit callback.

`freezeInput`, `onState` and `onError` are synchronous notifications; returned
Promises are not awaited and must not carry required cleanup. Asynchronous
cleanup belongs to the phased adapter methods. Every notification may close or
advance the scheduler; callers must read current status rather than interpreting
an older emitted status as continuing authority.

The normalized injection proof is not a new runtime protocol:

```js
{
  version: '1.0', attemptId: context.attemptId,
  owner: context.owner, surfaceGeneration: context.surfaceGeneration,
  consumedInput: {
    pageId: '1', routePath: 'pages/index/index', templateRevision: '5',
    viewport: { x: 0, y: 0, width: 375, height: 667 },
  },
  publication: { kind: 'external-frame', renderRevision: '8' },
  // DOM alternative: { kind: 'browser-view', key: {
  //   sessionId, pageId, documentRevision, presentationRevision,
  //   surfaceGeneration, profile: 'webview'
  // } }
}
```

The adapter creates this wrapper only from the real exact-revision/key-bound
prepare/frame metadata. It may add local attempt/owner identity, but may not fill
consumed fields from pre-request demand, latest `state`, post-hook data or ACK.
External metadata's direct f32 geometry must match the frame; DOM's existing f64
viewport is a separate encoding. The module copies validated numeric values and
does not invent a conversion. A missing authoritative consumed input fails
explicitly; it is not repaired with a guessed baseline.

A generated template must consume the captured page/route/logical viewport and
a template revision greater than or equal to the captured lower bound. Actual
clone5 for captured demand4 is valid. Paint must carry exactly the accepted old
consumed input even if current page data is newer. External revisions are exact
positive strings and must not predate demand or replay an accepted publication.
DOM validates the complete presentation key against captured session/page/surface.
It receives no outer numeric ACK from the scheduler.

`present()` returns a final with the exact same publication, `acknowledged:true`,
boolean `inputEnabled`, and optional boolean `requiresRestart`. It returns after
the genuine final transaction and preserves diagnostics/effects through the owner
lane. Any `consumedInput` or `scheduling` decorations on this final are ignored.
Committed input-disabled outcomes retain their actual visual baseline. If a
strictly newer ordered demand under the same immutable owner and complete hard
input key already requires template input newer than the clone-time consumed
input, or an external render revision newer than its exact publication, the
commit is superseded. Input stays frozen, no failure is invented, and the next
flight runs only after this candidate's release barrier. A successor must obtain
its own genuine enabled ACK. A restart-required final always remains terminal;
ACK decorations, a newer observation sequence alone, viewRevision/activity, and
revisions already consumed by the actual clone cannot justify supersession.
Without such a successor, an input-disabled commit remains an explicit failure
and blocked; unchanged activity cannot trigger another ACK/evaluation. A late
irreversible final can be marked `committed` for cleanup after a hard fence, but
can never become the new accepted state or input authority.

`release()` frees attempt-owned pending/transient leases; accepted/displayed
leases have been transferred to the presenter's accepted record. A committed
candidate must not be remotely aborted or have live displayed resources freed.
`committed:false` means the scheduler did not verify a genuine final; it does not
prove that local swap or runtime ACK never happened. The adapter must retain its
own irreversible-state record if present throws or returns a malformed final,
and must not infer safe rollback from this flag. Release is safe and idempotent
after cancellation. Candidates prepared after an abort
remain old-owner cleanup work. One flight includes release, so no second runtime
execution overlaps late cleanup. Resource authorization, budgets, URL/image
leases and final renderer disposal remain adapter responsibilities.

## Coalescing, failure and scheduling

Each flight captures one demand. Ordinary newer demand replaces one pending
value without aborting the flight or advancing presentation authority. A no-op
activity event schedules nothing. On success the accepted baseline comes from
the pre-presentation proof. The next flight runs only if newest template input
or retained paint revision is newer than that actual baseline.

Example: captured4, cancellation updates data before root clone5, component hook
writes6, ACK ready writes7. The first accepted baseline is5. The queued7 leads to
one successor; it is never falsely labeled already consumed. If the latest notice
was only5, there is no redundant successor.

Failure has a separate watermark, never an accepted baseline. Before proof it
uses captured demand; after valid preparation it uses the actual consumed proof.
Thus captured4 → clone5 → presentation failure → latest5 stays blocked. Unchanged
activity/timers cannot repeatedly evaluate the same failed input. A genuine newer
demand or explicit `retry()` admits one new attempt. Failed paint retries remain
paint work and cannot manufacture a fresh template. A release error
preserves any actual committed visual baseline, freezes input and faults this
scheduler. Cleanup has not been proven complete, so no automatic demand or
explicit retry may start another execution; the owner must close and report it.
RAF cancellation failure also faults ownership before error notification or
successor admission. Its error remains part of the final close aggregation.

The scheduler's RAF injection can implement the presentation FPS cadence; it does
not drive JS timers or explicit bridge turns. The generic frame-admission mode
can add a refresh interval; Worker CanvasKit uses microtask admission to avoid
that delay. No input-to-presentation bound is claimed here;
measure the real Worker/WASM/presenter development loop after product integration.

`requestFrame(callback)` synchronously returns the exact cancelable handle.
Its call may synchronously invoke integration code, including a hard observation
or close. Registration blocks successor admission until that returned handle is
known; if retired before return, the scheduler cancels the exact eventual handle
once, never `null` or a successor handle. `cancelFrame` may also reenter. A
requestFrame implementation that throws must not leave registered work without
returning its handle. A callback invoked synchronously is treated as completed
and needs no later cancellation. These contracts are independent of the actual
browser RAF cadence and do not establish a browser performance result.

## Stable close and finite cancellation contract

`freezeInput(reason)` is synchronous. An exception faults the scheduler; future
work cannot enable input. `close()` publishes its stable promise before invoking
any injected callback, marks closing/fences immediately, cancels RAF, aborts the
flight and freezes input. Then it calls, in order:

1. `cancelOwnedWork(reason)` to make owned pending operations settle, while keeping
   transport and exact-key cleanup reachable. It must not wait for the scheduler
   flight that is waiting for it, nor destroy transport needed by `release()`.
2. Await the flight including late-candidate release.
3. `dispose()` for final presenter/transport/Worker resources owned by the adapter.

All cleanup stages run after earlier failures. Errors aggregate into the close
promise; notification callback errors cannot acquire authority or skip cleanup.
A pending prepare/release must honor signal/cancelOwnedWork and settle in finite
time. The scheduler cannot force-terminate an arbitrary noncooperative Promise.
The product owner remains responsible for its actual RPC close/watchdog/owned
Worker termination. No duplicate app unload is generated by this module.

## Deterministic contract tests and evidence limits

`scripts/presentation-scheduler.test.mjs` contains deterministic deferred-promise
and fake-RAF cases for no-op activity, template/paint separation, actual clone
watermarks, post-hook/ACK updates, coalescing, same-failure suppression, hard
resize, hide/show, malformed proof, mutation isolation, blocked committed outcomes,
stale observations, family mismatch, DOM keys, stable/reentrant close, late ACK,
cleanup aggregation/fault, exact u64 values and retained-proof/receipt rejection.
The reentrancy corrections add 12 regressions for initial/queued hard
observation reentrancy, freeze-start rescheduling, late RAF handles, cancelFrame
reentrancy/failure, final restart and release-fault notification ordering,
preparing/presenting state callbacks and abort-listener reentrancy. All 35 tests
passed within the guarded `presentation-node-20261024-r1` run (316 tests across
six overlapping Web contract suites). The original V1 reentrancy diagnostic is
retained separately; a successor result does not rewrite that failure.

These tests use injected adapters. Rust, WASM and actual browser checks remain
separate. Pure fake-adapter tests cannot establish
real Worker proof wire, DOM phase behavior, CanvasKit submission, GPU completion,
resource cleanup in a real browser or any performance target.

### Validated frame ownership

The RPC client performs the bounded response walk and typed-image admission once.
Its successful frame result receives a module-private, single-use ownership receipt
bound to that exact client. The session supplies the underlying client alongside
its observation/presenter RPC facade; the adapter may consume that receipt and use
the received structured clone directly. An injected RPC, copied result, different
client, or second consumer cannot mint or reuse the receipt and retains the full
validation-and-copy path. Frame proof, target, presenter validation and ACK checks
remain required. Late responses retain their defensive copy and cleanup behavior.
