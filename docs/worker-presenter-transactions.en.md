<a id="工作呈现器事务显式-10-光入"></a>
# Worker presenter transactions (explicit 1.0 opt-in)

[简体中文](worker-presenter-transactions.md) · **English**


This source implements an opt-in product transaction over the low-level
[renderer transition protocol](worker-renderer-transition-protocol.en.md). It does
not enable simulator browser-auto, change the frozen 279 gates, or establish
browser, CanvasKit, physical GPU, seven-host or WeChat parity evidence. Authored
contract fixtures remain distinct from the root lane's execution reports.

<a id="条目"></a>
## Entry

A static Worker build can receive `--startup-intent /absolute/startup.json`:

```json
{
  "schemaVersion": 1,
  "execution": "worker",
  "engine": "quickjs",
  "viewport": { "width": 375, "height": 667 },
  "rendererPolicy": { "mode": "manifest" },
  "rendererTransitions": { "version": "1.0" }
}
```

The builder retains the exact bounded UTF-8 startup bytes and their SHA-256 in
`workerStartupIntent`, and includes the same opt-in in the generated pinned
product config. Mixed static products require explicit pinned CanvasKit/font
inputs (`--renderer canvaskit`). `workerProductOptions` passes the opt-in to
`WorkerWebSession.load`. It cannot be enabled by URL parameters. Embedders can
pass the same explicit object directly to `load`.

Omitting this field preserves fixed-family behavior and v1 observation
negotiation. Version 1.0 requires manifest renderer policy, QuickJS, native
actual-final tracking, external presentation/surface recovery and DOM query
preflight before `app.init`. Mixed-owner input-causal timing is not negotiated.
Initial DOM uses browser density; supplying physical render scale to a DOM
startup remains an explicit error.

The [three-route static example](../scripts/fixtures/worker-dual-renderer/README.md)
provides pack/build commands and a real-browser consumer. It uses hand-authored
public input to the real packer; it does not claim a `weapp-vite` compiler run.
Serve the generated site on an unused localhost port. Runtime readiness is
`window.weappReady`; the first accepted input-enabled view is
`window.weappPresented`. Inspect `window.weapp.status` for later transitions,
and await `window.weappClose()` before stopping the owned server. Static builds
and console readiness alone do not establish browser or GPU acceptance.

<a id="身份和数据流"></a>
## Identity and data flow

The original load result remains immutable. V2 observations retain their real
sequence and exact three-field runtime owner (`workerEpoch`, `sessionId`,
`packSha256`). A separate native binding names the session, transport family
and presenter generation. Local scheduler/adapter/font resources use the derived
five-field owner that includes `presenterGeneration`; they are not new runtimes
or new startup receipts.

Each adapter borrows a scope of the one RPC and one bridge correlation table.
Its RPC and bridge requests capture the binding and page/input/surface context
at entry. An old scope cannot substitute a current binding, fetch a successor's
resources, or send owner controls such as metrics. Owner metrics/visibility and
presenter transitions share the serial control queue. Original observations and
real effects still enter once through the owner before consumers see finals.

<a id="交易和清理"></a>
## Transaction and cleanup

A pending family observation immediately freezes input and suspends the old
scheduler. The owner stops new calls from that presenter and drains every
entered request through RPC `onActualFinal`; public timeout/cancellation is not
that barrier. Native `renderer.transition` alone retires the old runtime
presenter and returns the original effects, binding and input-lifetime final.
Business JS, timers, storage, page stack and the sole Worker remain owned by the
same runtime; startup and business requests are never replayed.

DOM candidate cleanup can await that exact whole-presenter retirement instead
of issuing an old-generation `view.abort`. This is a genuine native retirement
barrier, not an invented per-key abort ACK. The DOM adapter checks the exact
previous generation and source before accepting it. Local scheduler, DOM/GPU
resources, input helper and renderer lease drain before replacement resources
are installed. New binding adoption is not presentation: only the new adapter's
real ACK, geometry and scheduler proof can reopen input.

A native transition's public timeout retains the original operation until its
late actual final, rather than sending a second transition. A local asset or
presenter creation failure reports `presenterTransition.phase = "blocked"` and
keeps business requests available. When partial-resource cleanup succeeded,
`retryRendererTransition()` can retry without another startup;
`retryPresentation()` delegates to the same blocked transaction. When
`cleanupUncertain` is true, resources remain charged and retry is rejected
before allocating a successor. Partial-resource cleanup failures remain
recorded and bounded; they cannot prove cleanup success.

If navigation returns to the original family during the pre-native drain, the
locally stopped presenter is kept blocked because no native retirement has
occurred. It is not silently revived. A later pending demand can be explicitly
retried, or the owner can be closed. Navigation across further families after
a successful retirement is serialized with a bounded race retry budget.

Closing during an unfinished transaction uses the same RPC's genuine shutdown
final as a broader retirement barrier, then drains local cleanup. A terminated
or uncertain request remains a cleanup error. No second Worker is created.
Closing an accepted generation follows the ordinary presenter-before-RPC close
path. Repeated close reuses its owned barrier.

<a id="源合同和证据限制"></a>
## Source contracts and evidence limits

The new `scripts/worker-presenter-transaction.test.mjs` fixtures cover both
family directions, one startup, actual-final drain, stale scopes, local failure
and retry, a returned-family race, and an original late native final. Additional
existing suites have appended attachment, real bridge context, real scheduler
identity and static startup definitions. The product fixtures use fake native
and presenter peers; they cannot establish generated WASM or real rendering.

Real generated-WASM mixed DOM/Skia browser interaction, native callback errors,
context loss, compositor feedback and release/input performance must be run and
reported by the sole integration lane. Ordinary simulator browser-auto remains
closed until those gates provide the required evidence.


A renderer asset loader owns all partial resources until its successful lease
return; a rejection must release those untransferred resources internally. After
a lease return, the owner records it before checking cancellation. The owner
also records each canvas before passing it to the adapter factory. If that
factory rejects before returning a complete adapter and cleanup succeeds, the
owner removes its untransferred canvas and releases the transferred asset lease
before retry. A
factory remains responsible for any internal GPU/resource allocation it cannot
return after throwing; removing the owner's canvas does not assert that an
unreturned internal allocation was cleaned.

Local scoped admission honors actual-final 1.0 as strictly as raw RPC: a
not-posted callback must return synchronously, async rejection is observed, and
callback contract failures remain in diagnostics and cleanup results.


If a transferred partial adapter's scheduler, actual-final drain, destructor or
remote-final cleanup fails, its local last use is uncertain. The owner retains
that exact renderer lease and its byte charge, marks
`presenterTransition.cleanupUncertain`, and rejects renderer retries before any
new resource allocation. Business requests continue with input frozen. Close
retains the original cleanup failure and does not declare the uncertain local
resource released; a native Worker shutdown cannot prove a throwing local GPU
destructor succeeded. Clean partial failures release their lease and drop the
disposed adapter references before allowing retry. A count limit does not
substitute for the loader's charged byte budget.
