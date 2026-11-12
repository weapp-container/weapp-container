# Worker external surface recovery 1.0

This optional protocol replaces a lost CanvasKit/WebGL surface while retaining
the same Worker, Rust session, QuickJS realms, page stack, storage and timers.
It separates native input-lifetime revocation, retained frame publication,
local surface submission and the final runtime ACK. A `webglcontextrestored`
event or an RPC success alone grants no input authority.

The protocol extends [external presentation](./worker-external-presentation.md)
and the [ordered observation lane](./worker-ordered-observations.md). Its recovery
transaction applies to the `external-frame` transport; DOM presentation keeps
its own transaction protocol.

## Explicit load and Host/WASM negotiation

```js
const loaded = await worker.requestHost('load', {
  renderer: 'external-frame',
  externalPresentation: { version: '1.0' },
  observation: { version: '1.0' },
  surfaceRecovery: { version: '1.0' },
})
```

A manifest/force renderer policy may select external-frame instead. Recovery
requires both existing contracts and an external-frame selection. Before
manifest loading or `app.init`, the Worker requires these additional exports:

- `surface_recovery_contract_json()`
- `recover_external_frame_json(expectedJson)`

The first export is pure and returns exactly:

```json
{"version":"1.0","retainedExternalFrame":"1.0"}
```

The load result adds `surfaceRecovery` with that descriptor. Missing exports,
old/unknown descriptors, unsupported request versions or omitted prerequisite
contracts fail explicitly with `ERR_PROTOCOL_VERSION`. Selecting a DOM transport
fails with `ERR_UNSUPPORTED_CAPABILITY`. The Worker never tests support by
running application code or falling back to a normal render. Legacy callers
that omit `surfaceRecovery` do not probe its exports, retain their existing
response shapes and cannot call `surface.recover`.

## Loss, actual drain and exact expected input

On an owned context loss, the session immediately revokes local input, resets
its input helper and suspends the scheduler and presenter. It retains the
Worker and does not stop the application's timer pump. The recovery control
waits for both the scheduler's retired flight/release barrier and the adapter's
actual local/remote work, including a genuine late ACK final. Public timeout or
cancellation receipts do not substitute for that last-use barrier.

### Owned RPC finals and admission

The CanvasKit adapter requires the raw RPC client's independent
`actualFinalContract: '1.0'`. For each frame/ACK request it supplies a synchronous
`onActualFinal` callback. The callback receives one receipt:

```js
{ version: '1.0', status: 'final', requestId: 'request-prefix.7' }
```

`status` is one of these distinct transport facts:

| Status | Meaning for surface recovery |
| --- | --- |
| `not-posted` | Admission or setup stopped before `postMessage`; no remote turn can use this request. A pre-admission rejection has `requestId: null`; an admitted but unposted request retains its issued ID. |
| `final` | A correlated `ok` or `error` final arrived from the exact Worker, session, operation and request. A queued response is not a final. |
| `terminated` | The owning client's synchronous termination call for that exact Worker completed, but this request has no genuine final. Recovery drain fails; termination does not manufacture a native result. |
| `uncertain` | Termination failed. Cleanup reports the uncertainty and cannot authorize another surface or a replacement owner as successfully drained. |

Posted requests retain their final callback and payload reservation after a
public abort or timeout. These pins have their own finite admission count and
share the bounded in-flight byte budget; they cannot be evicted by the ordinary
retired-response ledger's TTL or count limit. Exhaustion rejects new work before
posting and preserves the reserved close control budget. Late effects and ACK
metadata reach their consumer before the corresponding late final releases its
pin. Duplicate finals cannot deliver those effects twice. Callback failures are
transport failures, rather than successful drain receipts.

The adapter registers its actual-work promise before calling RPC, so synchronous
admission rejection cannot leave an invented remote operation pending. Public
request settlement and actual-work settlement remain separate. If a posted
operation supplies no genuine final, recovery keeps waiting with input disabled;
elapsed time, a diagnostic-ledger eviction or an explicit retry cannot declare
it drained. Closing the exact Worker can settle that wait as a cleanup failure.

### Clone proof survives local cancellation

The scheduler's exact attempt context includes a synchronous
`retainFrameProof(proof)` lane. The actual CanvasKit adapter calls it only after
validating the original Worker `frame`/`frame.current` response's session-bound
consumed input, publication and physical target. The scheduler independently
copies and validates the owner, attempt, captured demand and publication; an
attempt cannot replace its original proof with a different clone.

This lane is separate from creating a presenter or returning a prepared local
candidate. A context loss during asynchronous presenter creation can cancel and
dispose that resource while keeping its already validated clone. A posted frame
whose public wait was cancelled can deliver the same evidence through its real
late final, including after the diagnostic TTL expires. It creates no canvas,
ACK, accepted presentation or input authority. The ordinary remote-final drain
still runs before recovery resumes.

The ticket's `base` is an immutable snapshot at the scheduler's local flight
drain. A late remote final may supply proof afterward to the same recovery's
internal exact-flight slot; the session also waits the adapter's actual remote
drain before using that slot. Navigation, incompatible input, a retired recovery,
or close prevents late evidence from reviving it. When the native recovery is
`retained`, compatible evidence selects `frame.current` rather than executing a
stateful View a second time. `render-required` still selects a normal template
render. Neither path fills consumed input from current state or an ACK.

The scheduler ticket records the original loss observation (`source`) and any
compatible historical clone proof (`base`). That proof is never accepted input
authority. The session constructs `expected` from the latest genuine ordered
observation after drain; it does not relabel the historical proof or invent a
surface generation. The Worker request is an outer owner operation, not an
inner application bridge API:

```js
const result = await worker.requestHost('surface.recover', {
  version: '1.0',
  expected: {
    sessionId: 'session-1',
    pageId: '1',
    routePath: 'pages/home/index',
    viewport: { x: 0, y: 0, width: 375, height: 667 },
    rendererProfile: 'skia', // or skyline-compat within this transport
    templateRevision: '12',
    renderRevision: '8',
    inputLifetimeRevision: '3',
    surfaceGeneration: '4',
  },
})
```

The request and expected object admit only the documented fields. The Worker
checks the exact session, page, route, logical viewport, effective renderer
profile, template revision, render revision, native input lifetime and Worker
surface generation against its current genuine observation. Lifecycle must be
Active and the runtime healthy. Rust repeats all native checks; Worker surface
generation remains owned by the observation lane and is not passed to Rust as a
native fact. `recover_external_frame_json` accepts at most 16 KiB of expected
JSON, rejects unknown fields and verifies the loaded host uses external-frame.

All identifiers representing u64 values are canonical decimal **strings** in
the full u64 domain. Do not convert them to Number or accept leading zeros,
fractions, negative values or overflow. Page and surface-generation tokens are
positive; native lifetime can start at zero. Render revision zero can only take
the render-required path before a generated frame exists. Logical geometry is
finite, bounded by the product's 4096-pixel edge limit and compared exactly to
the original observation/frame geometry, without DPR conversion or independent
rounding.

The Worker preflights available render, lifetime, surface-generation and
observation-sequence increments before calling native recovery. Rust also checks
native lifetime and render increments before mutation. Exhaustion returns an
explicit error (`ERR_ENGINE` at the Worker counter boundary, `ERR_RENDER` at the
native counter boundary); counters never wrap or saturate into a fake recovery.
A stale expected field returns `ERR_CANCELLED` without native mutation, retained
proof replacement or contact cleanup. A malformed request fails with
`ERR_PROTOCOL_VERSION`.

## Two explicit outcomes

Both paths return this seven-field receipt, using original string tokens:

```js
recovery: {
  version: '1.0',
  kind: 'retained', // or render-required
  sessionId: 'session-1',
  previousRenderRevision: '8',
  renderRevision: '9',
  previousInputLifetimeRevision: '3',
  inputLifetimeRevision: '4',
}
```

The enclosing result includes the new genuine `observation`. Native lifetime
increases by exactly one, which causes the Worker to mint a new surface
generation and observation sequence, also exactly one later within this
operation. It preserves the owner identity. Neither outcome runs JS, drains JS
microtasks, invokes View expressions or ready hooks, lays out nodes, performs CPU
rasterization/readback, calls a presenter or acknowledges presentation.

| Outcome | Native publication | Worker result | Next presentation |
| --- | --- | --- | --- |
| `retained` | Clone and commit the exact already laid out external frame; render revision increases by one, app frameId remains unchanged | `recovery`, `frame`, `renderRevision`, `viewRevision`, `scheduling`, `target`, `observation`; no effects batch | A fresh presenter submits the retained commands, then the real new-revision ACK is required |
| `render-required` | Revoke proof and input lifetime only; render revision remains unchanged | `recovery`, `observation`; no frame, scheduling proof, target or effects batch | The scheduler performs a normal template render in the new lifetime, then submits and ACKs its new publication |

Retained reuse requires the native committed clone input to match the current
expected page, route, template and viewport exactly. It also requires that the
retained frame owns that viewport. Missing, explicit-data, manual or dirty proof
takes `render-required`; the runtime does not fill proof from current state.
The previous image may remain available as diagnostic data, but its pending
presentation, observer ownership and input proof are revoked, so ACKing that
unchanged old render token fails. A later normal render establishes new owner
metadata.

Both outcomes clear native touch capture, ended-contact bookkeeping and
`ScrollRegistry` touch positions. This is pure retirement: it invokes no JS
touchcancel or scroll callback. Scroll offsets, deferred scroll commands,
pending scroll notifications, layout, application data and resources remain
intact. A pointer id reused on the new surface cannot inherit an old scroll
delta.

## New publication, ready hooks and input authority

Recovery sets native presentation and observer geometry to unpresented. The
page adapter constructs a fresh owned CanvasKit presenter and validates the
original new render token, clone input, target and surface-generation proof.
It submits locally before requesting the runtime's structured external ACK.
The ordinary scheduler/adapter acceptance gates still apply; the recovery
receipt itself contains no permit or `inputEnabled` result.

An unacknowledged generated frame retains its pending presentation metadata
when republished. Its ready hook runs on the actual new publication ACK, once.
If the old frame was already acknowledged, recovering and ACKing it does not
repeat ready. Late old-render ACKs cannot authorize the replacement surface.
Only a genuine final for the new publication, matching the current generation
and page/viewport lifetime, may enable input. Queued, restored-event, local flush
or HTTP/RPC receipts cannot do so.

## Dirtiness, retry and close

The ordinary Browser development UI displays the current recovery phase and
offers **重试画面恢复** only for a blocked surface. Its application/manager
entry point, `retrySurfaceRecovery({ ownerKey, lossId })`, binds the action to
the exact live owner and loss. Repeated clicks share that operation; close
fences queued admission and retains admitted work until settlement. A retry
result is a native recovery outcome, not a presented-frame receipt. Input
remains disabled until the normal GPU submit and native ACK accept the new
surface. The diagnostic `window.weappContainerDev` handle exposes the same
explicitly bound method, separately from `retryCleanup()`.

Timers and application state continue under the existing owner semantics while
presentation is suspended. A timer or setData may make the retained clone dirty;
the native `render-required` branch then creates a real revocation fence before
normal View evaluation. Later dirty observations also invalidate incompatible
scheduler reuse. Page/route/viewport/profile/lifecycle changes retire the old
transaction; historical proof is not retargeted to the new state.

The session serializes recovery with metrics/lifecycle controls. It retries an
exact `ERR_CANCELLED` observation race at most three times using newly received
genuine observations. Continued races leave recovery `blocked` and input
disabled, with an explicit retry diagnostic. Background recovery is also
blocked. Hidden/resize transitions retain their own fences; showing obtains its
real lifecycle observation before resuming a fresh recovery transaction.
`retrySurfaceRecovery()` retries a blocked transaction. If native recovery has
already succeeded and presentation is pending or locally blocked, it retries
presentation using the same native receipt and retained proof, without minting
another native lifetime. `retryPresentation()` routes through that same
recovery operation while a loss is outstanding. A new context loss can retire
the in-progress transaction again.

A local presenter creation/submission failure leaves the live Worker and timer
pump intact, with recovery blocked and input disabled. Explicit retry can clear a
failed local drain only after all real local work and owned remote finals have
settled; it does not borrow a Worker-termination receipt. Protocol, engine,
manifest or unsupported-capability faults still fault the owner. A failing
presenter destructor retains its exact uncertain resource and cleanup error;
retry and close never invoke that destructor again or claim successful release.

Close immediately disables input, aborts public waits and retires the owner.
Cleanup first waits for scheduler/adapter local GPU last use and retires its
owned surfaces. It then releases the owned input helper, renderer asset lease
and bridge, closes the exact Worker, and finalizes the adapter's remaining owned
remote operations before waiting for queued controls and removing the owned
mount. A Worker termination with missing request finals ends those waits with
cleanup errors, so close cannot deadlock on a public cancellation or report the
missing native final as clean drain. Late recovery/ACK results cannot publish
surfaces or reopen input after close. A finite public close timeout is not proof
that underlying resources drained; failures remain diagnostics and do not
authorize broad cleanup of unrelated Workers or canvases.

## Validation boundary

Node fake-host, scheduler, session and adapter tests exercise protocol and
ownership contracts. They do not prove Rust execution, the compiled WASM
exports, actual WebGL restoration, GPU hardware or latency. Authored Rust tests
cover retained state, unacknowledged ready, dirty revocation, atomic rejection,
storage/timer retention and pointer-delta retirement; their execution remains a
separate native gate. Parent integration must run Rust/WASM checks and owned real
browser context-loss/recovery tests, then report physical hardware and
performance evidence separately. This document does not mark those gates as
passed or change the frozen dual-renderer conformance inventory.
