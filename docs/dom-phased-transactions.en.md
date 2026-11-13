<a id="dom-阶段性事务和资源释放协议"></a>
# DOM phased transactions and resource release contract

[简体中文](dom-phased-transactions.md) · **English**


This is a local transaction API, independent of Worker scheduler wiring. It does
not claim browser, GPU, host, performance, or official WeChat acceptance.

<a id="分离-api"></a>
## Split API

```js
const prepared = await client.prepareTemplate(render, { signal, hostContext })
// No runtime permit, local swap, final ACK or input activation has occurred.
try {
  const result = await client.presentPrepared(prepared)
  // Real runtime ACK followed by exact local async confirmation.
} finally {
  await client.releasePrepared(prepared)
}
```

One split transaction is allowed until it is presented or explicitly released.
`prepared` is an exact frozen opaque client-owned object containing `key`,
`releaseMode` and optional copied `scheduling`. Handle copies and handles owned
by another client are rejected. `presentPrepared` consumes a handle once.

`releasePrepared` returns one stable promise. Before runtime ACK it aborts the
local candidate and asks the runtime to abort the exact key. After genuine ACK,
it retains the accepted image and resource leases until replacement/shutdown.
The result is `{released:true, acknowledged, remoteAbort, resourceBarrier}`.
`remoteAbort` distinguishes `confirmed`, `not-required`, `not-prepared`,
`unavailable` and failure. Unavailable remote cleanup is not confirmation.

Signal abort, authority invalidation, disconnect and disposal retire idle split
work on the same serial lane. Release failures reject and reach diagnostics.
A scheduler must fault on rejection; it cannot treat diagnostics as cleanup.
Runtime ACK is irreversible: cleanup cannot undo application effects, and an
accepted image stays noninteractive when local confirmation fails.

<a id="严格默认值与传统兼容性"></a>
## Strict default versus legacy compatibility

Split preparation defaults to `releaseMode:'strict'`. Before any runtime
request or replacement side effect, the client validates these presenter
methods: `candidateReleaseContract`, `releaseCandidate`, `drainCandidate`,
`confirmAsync`, `disposeAsync`, and `drainDisposal`.

The exact versioned descriptor is:

```js
{version:'1.0', exactHandle:true, pendingAcquisitions:true,
 asynchronousDisposal:true, asynchronousConfirmation:true,
 asynchronousShutdown:true}
```

Class identity or a claimed descriptor alone grants no authority. Methods must
exist, and release/confirmation/shutdown results are checked for exact field
sets, version, owned handle, key, receipt/presenter identity and settled state.

Existing constructor usage and the full `client.present(render)` convenience
remain compatible with legacy presenters implementing the prior synchronous
transaction API. An explicit split `{releaseMode:'legacy'}` is also permitted;
its outcome reports `resourceBarrier:'legacy'`. Boolean `presenter.abort()` and
synchronous `presenter.dispose()` retain their return behavior. Those legacy
methods cannot establish an asynchronous resource-release barrier.

<a id="精确的呈现器合约"></a>
## Exact presenter contract

`releaseCandidate(handle,{resumePrevious:false,timeoutMs})` accepts only the
original presenter-owned candidate handle and returns a stable promise. It
records disposal once, even under reentrant resource callbacks. Successful
results have the exact form:

```js
{version:'1.0', handle, key, status:'released' /* or 'retained' */,
 cleanupPending:false}
```

`drainCandidate(handle)` exposes the underlying actual unbounded drain. It
includes original candidate creation, plan/resource preparation and population
promises, plus all late disposal work they produce. Returned rejecting cleanup
promises stay observable; no-op rejection observers only prevent unhandled
rejection noise and do not convert failure to success. Cleanup drains to a
fixed point, not one snapshot of already available work. Synchronous disposal
errors remain recorded even if boolean abort already returned.

Plans retain synchronous `dispose()` for compatibility. `disposeAsync()` is a
shared once-only lease barrier, including Promises returned by lease release.
Candidate disposal may be synchronous or return a Promise of an error array or
nothing. Optional candidate `disposeAsync()` is also awaited. A presenter-owned
plan release fence prevents synchronous delegation of `plan.dispose()` from
revoking leases before asynchronous candidate disposal finishes. Actual plan
release, including synchronous errors, runs after that last-use fence.

Cleanup first requests optional candidate `cancel()` and freezes/hides the
candidate, then waits the original population operation before invoking its
disposer. A custom candidate that ignores cancellation keeps the actual drain
pending; the presenter cannot retire its plan while it still has last use.
Candidate disposal must not wait for presenter-owned `plan.disposeAsync()` from
inside its own disposer: that reverses the ownership dependency and remains a
pending timeout, never a claimed successful release.

The built-in browser provider cancels and settles its own RAF promise before
frame destruction. Cancellation terminates the local continuation waiting on
browser-global font readiness without claiming the global font set completed.
It removes image `src` to request decoder cancellation, retains the actual
original decoder promises, and keeps frame/leases owned until those settle.
Image source removal is not evidence of decoder settlement. A decoder that
never settles yields pending cleanup; bounded timeout leaves it observable.
The provider unit shim tests are auxiliary proof; actual browser testing is a
separate root-owned gate.

`confirmAsync(receipt,{inputEnabled,timeoutMs})` requires the original exact
committed receipt. It irreversibly confirms with input disabled, retires the
predecessor, awaits actual predecessor resource disposal, and only then opens
input and admits initial geometry. It never adopts a presentation previously
confirmed by the legacy synchronous API. A failed predecessor barrier retains
the new confirmed image, reports failure and keeps input frozen.

Its successful result is exactly:

```js
{version:'1.0', handle, key, receipt, inputEnabled, cleanupPending:false}
```

`disposeAsync({timeoutMs})` claims one stable promise before any synchronous
callback. It retires and drains every tracked owned entry, including entries
that a throwing legacy callback might have skipped. The successful exact
result is `{version:'1.0',presenter,status:'disposed',cleanupPending:false}`.
The client closes its transport after the presenter barrier; it still closes
the transport when that barrier fails. `drainDisposal()` exposes actual shutdown
work after shutdown starts.

<a id="超时和失败语义"></a>
## Timeout and failure semantics

A bounded release/confirmation/shutdown can reject `ERR_TIMEOUT` with
`releaseOutcome.cleanupPending:true`. That exact promise stays rejected even
if cleanup later finishes. Timeout does not prove resource release. Call the
actual drain API to observe eventual success/failure; never reopen input merely
because a timer expired. A provider ignoring cancellation can leave actual work
pending indefinitely. Strict preparation cleanup failure attaches its actual
`cleanupDrain` and cleanup errors to the preparation failure.

A presenter tracks resources and promises returned to it. It cannot prove the
release of hidden resources a provider allocates and never returns. Failures
retained for shutdown are currently unbounded diagnostics, not a performance
acceptance claim. This candidate does not validate untrusted custom presenter
implementation internals, wire a Worker product adapter, implement paint-only
DOM reuse, or establish GPU/presentation completion in other hosts.

<a id="验证所有权"></a>
## Validation ownership

The integrated implementation has local Node, native and standalone headless
presenter results retained in the [presentation contract archive](archived-evidence.en.md).
The root-owned immutable validation supervisor records the exact source map
and original outcome for each run. Relevant test entry points include
`dom-session-client`, `dom-presenter`, `worker-bridge-transport`, `remote-dom`
and `simulator-dom-client`. These overlapping checks do not establish the actual
Worker product entry. Product browser evidence remains a separate gate.
