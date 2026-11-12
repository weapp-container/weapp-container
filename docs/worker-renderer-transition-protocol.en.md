<a id="工作渲染器转换协议片断"></a>
# Worker renderer transitions (protocol slice)

[简体中文](worker-renderer-transition-protocol.md) · **English**


This optional protocol separates one stable runtime owner from successive page
presenter bindings. It is the first source slice of cross-family browser
navigation, not an enabled simulator or standalone-browser feature.

`WorkerWebSession`, presenter admission, CanvasKit/DOM resource leases, input
adapters, scheduling and the CLI do not negotiate this contract yet. The current
product retains its existing fixed-family restart behavior. In particular,
`--web-runtime browser --renderer auto` is not enabled by these exports.

<a id="协商和身份"></a>
## Negotiation and identities

The low-level Worker load explicitly requests all of:

```js
{
  renderer: 'auto',
  rendererPolicy: { mode: 'manifest' },
  observation: { version: '1.0' },
  externalPresentation: { version: '1.0' },
  rendererTransitions: { version: '1.0' }
}
```

The Worker checks the pure native `renderer_transition_contract_json` export
before application code executes. After loading the original HostSession and
before `app.init`, it calls `enable_renderer_transitions_json`. No replacement
Worker, HostSession, AppService or JS realm is constructed. The native contract
advertises `runtimeOwner`, `presenterBinding`, `inputLifetime` and
`transitionFinal`, all version `1.0`.

The stable runtime owner is exactly `{ workerEpoch, sessionId, packSha256 }`.
Negotiated observations use version `2.0`; they carry that owner and a separate
presenter binding:

```js
{
  version: '1.0',
  sessionId: 'session-id',
  generation: '1',
  transportBackend: 'external-frame' // or 'browser-view'
}
```

Generation starts at `1`, increments only after an accepted cross-family
transition, and uses checked canonical u64 strings. It is not a render revision,
logical surface generation, presentation permit or input ACK. Old v1
observations and callers keep their four-field fixed-family owner and existing
restart requirement; v1 values cannot be relabeled as v2.

A DOM-first owner can preflight the external-frame contract; a Skia-first owner
can request `browserQueries: { version: '1.0' }` before initialization. Browser
queries remain opt-in. Mixed-owner causal input timing is not negotiated in
this slice; combining `inputTiming` with renderer transitions fails explicitly.

<a id="所有者线程状态机"></a>
## Owner-thread state machine

A genuine business turn can navigate to a route in the other family. The v2
observation then reports `transitionRequired: true` while retaining the old
binding. Business timers, navigation, storage and diagnostic turns continue;
presentation, resource requests and input operations cannot use this pending
state. No renderer policy fault, timer cancellation or automatic session
restart is manufactured.

The supervisor submits `renderer.transition` with version `1.0` and exact
`expected` values from the observed pending page:

```js
{
  version: '1.0',
  expected: {
    sessionId, pageId, routePath, rendererProfile,
    inputLifetimeRevision, presenterGeneration,
    transportBackend, surfaceGeneration
  }
}
```

The Worker validates the page, hard input lifetime, logical surface generation
and old binding. It reserves the next checked counters before entering native
retirement. Native code drains both DOM and Skia input on the original owner,
revokes presentation and contact authority, and retires the hard input lifetime.
Cancellation hooks can execute application JS. They are never split, replayed
or rolled back.

After those hooks settle, native code rechecks the actual page/profile and hard
input lifetime. A race returns `ok: false`, `ERR_CANCELLED`, the real effects
batch and original binding. If hooks throw, the original native exception is
preserved; committed retirement effects remain in the existing Session
retirement diagnostic flow and are not synthesized into a success final.

A successful final increments the presenter binding, selects the required
transport on the same WebHost, and preserves the page stack, app state, storage,
timers and original session identity. Its complete native effects batch is
retained. The final explicitly grants no input. A missing or malformed native
final faults the Worker owner and preserves any returned effects for diagnostics,
because native cancellation or binding replacement may already have committed.

After that failed admission, `state` explicitly reports
`presenterBindingStatus: "uncertain"`, the last `acceptedPresenterBinding`,
`nativeObservedState` from the pure native state export, the original protocol
fault and returned effects. The diagnostic is not an admitted v2 observation.
The last genuine observation is retained without a new sequence; neither the
rejected generation nor the native transport is relabeled as an accepted binding.
Receipt acknowledgements and exact-owner shutdown continue, including when
native state differs from the old accepted transport. Ordinary presentation,
input, resources and business calls remain stopped. Shutdown preserves the
binding-fault effects in diagnostics and releases the original owner once.

<a id="演示和输入屏障"></a>
## Presentation and input fences

Every negotiated presentation host request carries an exact
`presentationContext`:

```js
{ presenterBinding, pageId, inputLifetimeRevision, surfaceGeneration }
```

This applies to frames, ACKs, recovery, resources, scale, retire and abort.
Presenter bridge operations also require the context and one indivisible
native envelope per call; business bridge batches retain their normal atomic
semantics. Stale contexts are rejected before native presentation/resource/input
code runs. Ordinary queue capacity is used for transitions; shutdown retains
its reserved cleanup credit.

A new external binding cannot adopt an older retained Skia tree. Native WebHost
requires current generated-frame input proof for frame export, ACK, density
and recovery when the optional contract is enabled. The Worker additionally
tracks the exact external export by presenter generation, page, hard input
lifetime, logical surface and render revision. `frame.current`, ACK and recovery
cannot restore a previous binding's pixels or authority, including when returning
to the same page. A normal `frame` request must create the new binding's first
frame. Density updates wait for its accepted layout and do not evaluate View
expressions by themselves. The existing external ACK or DOM commit protocol
must then confirm actual presentation; this transition final is not such proof.

Closing uses the shared DOM/Skia retirement operation and releases the one
owned HostSession exactly once. Native UI/GPU resources still belong to their
presenter leases; this protocol does not create or dispose browser presenters.

<a id="剩余的产品工作和证据边界"></a>
## Remaining product work and evidence boundary

The next slice must atomically coordinate `WorkerWebSession`, presenter and
scheduler replacement, resource leases, late query/ACK results, actual DOM and
CanvasKit presentation, input cancellation, context recovery and shutdown. Only
then can the product negotiate this profile and the CLI browser-auto guard be
considered. Static exported sites and each native host remain separate work.

The accompanying Rust definitions exercise native identity, storage/timer
retention, stale preflight, opt-in/unload and frame-proof rejection. Injected
Worker tests define bidirectional binding changes, timer/ready/resize navigation,
stale input/ACK/resource fences, cancellation races, malformed finals, exact v2
observations and cleanup. Authoring these definitions is not execution evidence.
They do not establish actual WASM/QuickJS execution, browser presentation, GPU,
performance, seven-host compatibility or official WeChat parity. The frozen
279 acceptance gates are unchanged by this protocol slice.


<a id="可信原生交错定义"></a>
## Trusted native interleaving definitions

The additional QuickJS-only native definitions use one original WebHost and
its public `app.init`, lifecycle, View prepare/geometry/commit/present and touch
event APIs. The geometry peer is synthetic; the JS event listener and its
storage, data, timer and navigation effects execute in the actual compiled
QuickJS provider when the root runs those tests.

A trusted native embedder deliberately attaches the target DOM before asking
WebHost to change its transport binding. That public API interleaving exercises
retirement callbacks that navigate away, navigate away and back within one
turn, or throw after committing writes. It does not represent a path admitted
by the current Worker protocol: normal Worker navigation already cancels old
page contacts before exposing a pending renderer-family transition. No Session
fields are modified to forge a callback, page, input lifetime or result.

These definitions require callback effects to survive, the old binding to
remain unchanged on cancellation/error, old permits and touches to stay
revoked, business timers to remain on the original owner, and repeated local
retirement/unload to avoid replaying the contact. They establish no browser,
GPU, device, native-platform cleanup or official WeChat parity evidence.
