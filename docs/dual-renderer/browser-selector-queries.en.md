<a id="dom-selectorquerypartial-实现与证据边界"></a>
# DOM SelectorQuery (partial implementation and evidence boundary)

[简体中文](browser-selector-queries.md) · **English**


DOM queries are performed by Rust against the already-evaluated `ViewDocument`, where the browser batches measurements of the currently visible portion of the same document, and the runtime then fulfills the original JS request. It does not read the retained Skia frame, does not re-execute WXML/WXS/modern View, and does not treat the previous `view.geometry` cache as a measurement at the time of invocation.

Capabilities remain as `partial`. Historical compilation, native regression, and real QuickJS Worker query results are preserved according to the actual tested source code in [controls integration evidence](../archived-evidence.en.md); the controls r6 browser binds to `4f753cab` and does not automatically overwrite later backend/lazy source code. The fixed WeChat version, GPU, device, and performance acceptance have not been completed; the frozen list of 279 releases remains unchanged. Remote startup waiting, IntersectionObserver, and the DOM gate for `pageScrollTo` continue to be disabled.

<a id="协商与启动"></a>
## Negotiation and Startup

- Worker: The default real DOM adapter factory explicitly requests `browserQueries: {version: "1.0"}` during load. At runtime, before `app.init`, it executes `view.query.enable` with a payload of `{version: "1.0", scope: "session"}`. A clear failure occurs when either the contract is missing or when native rejection happens; an injected adapter factory must explicitly declare the same capability, and old fake ones will not be automatically enabled.
- Remote: At initial `onLoad`, there is no real preview recipient yet, so it still returns unsupported. After actual ACK/confirm, the preview is sent via the existing main preview lease with `{version: "1.0", scope: "presentation", key}`; once the key is retired, the capability is disabled, and a new owner or new presenter cannot inherit it. The waiting execution during Remote startup remains a required step and cannot be equated in semantics to Worker startup.
- `{version: "1.0", scope: "disabled"}` explicitly revokes. A successful final includes `ok`, `version`, `scope`, `enabled`, `key`; HTTP queue receipts do not count as successful.

The negotiated Worker's `onLoad` can invoke `exec`: the runtime is bounded to preserve the original page/component owner, input lifetime, and the first absolute deadline; timers continue to run. Its actual `ViewDocument` is matched and measurements initiated only after the first valid ACK. Ordinary candidate retries do not extend the budget; hide, unload, logical resize, manifest/session boundaries, component destruction, and timeout cancellation of waiting do not borrow the identity of the current page.

<a id="查询协议-v10"></a>
## Query Protocol v1.0

Runtime emits a `view.query.request` event:

```json
{
  "version": "1.0",
  "requestId": "dom-query:1",
  "key": {
    "sessionId": "session-1",
    "pageId": "1",
    "documentRevision": "1",
    "presentationRevision": "1",
    "surfaceGeneration": "1",
    "profile": "webview"
  },
  "afterEpoch": "0",
  "deadlineNs": "Unix 纳秒的规范 u64 十进制字符串",
  "occurrenceIds": ["Rust 匹配的 occurrence id"]
}
```

`requestId` strictly increments within a session; epoch and deadline are not converted through JavaScript Number. Browsers do not compare non-shared clocks, and the final deadline is validated by Rust. The range selection is determined by Rust, and the browser will not execute the CSS selector provided by the user.

The browser performs a complete geometry measurement on the current confirmed/interactive candidate within the original transaction lane, and verifies the same key, connection, and main preview input fence before and after the measurement. The successful `view.query.result` payload is `{version, requestId, key, geometry, viewportScroll: {x, y}}`. The geometry must include the complete document occurrence set, the epoch must be greater than the requested `afterEpoch`, and must also be greater than the query measurement epoch of the most recent atomic acceptance for the same complete key. The runtime maintains the input geometry and a bounded query epoch high water mark, and does not allow replay of old measurements across requests or for the same key. If concurrent results are out of order, the old epoch is rejected in bulk and retained as pending, and may be retried with a higher epoch within the original deadline; invalid batches do not advance the high water mark. This snapshot does not overwrite the input geometry/cache; the next normal geometry update will still use a monotonically increasing epoch.

Failed payload is mutually exclusive with success: `{version, requestId, key, error: {code, message}}`. Only accepts `ERR_RENDER`, `ERR_CANCELLED`, `ERR_TIMEOUT`, `ERR_INVALID_REQUEST`; does not accept any host error codes. All results are first validated against request/key/epoch/current presenter/owner/cancellation and deadline; only after full success is the pending entry atomically removed and passed to JS. Invalid batches are not partially executed; duplicate or late results cannot be completed twice.

<a id="支持范围与预算"></a>
## Support Scope and Budget

Supports the existing portable selector subset, source order, `select`/`selectAll`/`selectViewport`, `boundingClientRect`, `scrollOffset`, and `fields` with rect/size/geometric fields, id, dataset, and mark. Metadata retains the original declared JSON values; `properties` only supports verifiable `id` and `class` declarations. Real-time platform attributes such as `computedStyle`, node/context handle, and input.value are explicitly unsupported. Missing single selections retain `null`; missing multiple selections retain `[]`.

query owner is independent of the `.in(...)` range. Both engines capture the same real object residing in the instance table, and callbacks iteratively inspect and synchronize its owner; no Promise/async continuation automatically inherits ownership. Destruction or ID reuse does not revive the old owner. Direct bridge of `api.call` lacks a trustworthy JS owner, thus DOM SelectorQuery is explicitly unsupported.

Native and browser both allow up to 32 requests, 256 KiB per request, and a total queue of 1 MiB. Native also limits each batch to at most 256 operations and 100,000 matches, with budget calculated based on serialized wire payload, retaining options, match ID, and captured cancel token bytes. The first deadline defaults to a maximum of 5 seconds and is shortened by the original bridge deadline; candidate retries, timer ticks, and queue promotion do not reset it.

The runtime installs a request scope before the first engine call in the original bridge turn, capturing its `cancelToken`; if the internal query options carry a token, either fence cancellation causes the original query to fail. The first frame waits for promotion, directly transferring the initial deadline/token, without inheriting later ACK/result transport token or deadline; after turn exit, the original scope is restored, not polluting the next bridge message. `cancel` continues to update only pure control state, and query callbacks are executed on the next normal owner effect drain. After full result validation and projection, atomic consumption of pending items, and before entering JS, the original deadline and cancellation state are validated again. If budget is exceeded, a structured error is returned, without returning to the old cache.

<a id="验证状态"></a>
## Verification Status

New Rust use cases cover explicit negotiation, first frame waiting and timer, hide/unload, truly fresh batch, input epoch independence, invalid/late results, old key inheritance not preserved, and field support not provided. Integration auditing further supplements the original bridge cancellation and scope recovery, first ACK-before-cancellation, ACK transport not re-binding the first fence, waiting/pending deadline, replay and out-of-order result retry across requests or same key negotiation; a fixture for 32 concurrent requests uses incrementally measured epoch. Actual execution results of these use cases must be verified against the tested source code as per the integrated archive; historical results do not supersede current submission of complete regression.

Previously isolated branch Node records are located at `artifacts/browser-selector-node-20261025-r2/`, archived to `docs/evidence/2026-10-25-dom-selector/`: 23 test files showed consistent source code hashes across 24 changed files during execution, 1,012 passes; the existing mixed renderer smoke suite could not load due to missing `acorn` in this checkout, dependencies not installed or marked as passed. The initial 1,005 passes and identical dependency blocking were preserved as-is. These historical results do not cover later integrated and fence-fixed source code; integration audits require re-bonding the final source code with original logs. The Node use case validation protocol and extracted JS bootstrap do not represent native QuickJS/V8 execution passing. Subsequent native, actual Remote/Worker measurement and performance results must be tied to the final source code and preserved separately; Node fakes cannot be used as substitutes.

<a id="显式真实-worker-查询-smoke-入口"></a>
## Explicit Real-time Worker Query smoke Entry

`scripts/browser-dev-loop-smoke.mjs` can be augmented with `--server-kind cli --renderer webview --dom-queries true`. The `--server-bin`, `--producer-dir`, `--pins`, `--node-bin`, and a new `--out-dir` must still be provided explicitly; the script will not build runtime, generate trust pins, reuse existing previews, or treat failed runs as successful. Query checks are disabled by default, and Skia/context recovery workflows do not enable this parameter.

fixture calls `wx.createSelectorQuery().select('#tap').boundingClientRect()` and viewport `scrollOffset` inside a real mini-program's `onLoad`, and performs the first `exec` callback to create a second query. There is no `setData` between the two measurements to verify that the callback retains the original instance, shares the same presentation key, has an independent query epoch, and maintains a consistent input epoch; `setData` is only called in the second callback, and it waits for the subsequent accepted document display state. The `onLoad-return` must occur before the query callback, and the zero-delay timer must actually run, without requiring a fixed ordering relative to the first ACK's scheduling.

The real increment click point of the presented page changes the layout; then, for actual `#tap`, a test-specific `translateX(13px)` is added, and after a real tap on the same accepted key, a `wx` query is invoked. The returned coordinates must match those independently read from the browser DOM, and reflect the 13px displacement not yet included in the input geometry cache. Browser measurements are used only as an independent oracle and for test perturbation and cannot replace `wx` calls or submit forged query results.

Audits only observe the actual send/event/final of the original Worker, associating native negotiation, presentation ACK, query request, complete measurement, native result, and subsequent accepted proof by owner/session/key/request id. Records up to 512 entries, each 256 KiB, totaling 2 MiB; any truncation, timeout, rejection, error, or unprovable boundary will cause smoke to fail. Hot updates, build failures retention, and Stop of original resources' ownership/doorlock closure continue to execute. `dom-query-*.json` stores the facts from each loop closure, and the final report preserves the consolidated cleanup results.

This entry has been executed during the real QuickJS Worker development cycle in controls r6: `4f753cab` saved 15 sets of query proof and corresponding raw observations, and completed 12 updates, 13 actual Worker closures, and original service cleanup; earlier failed attempts are retained as-is. The corresponding Node use cases only validate the test entry, bootstrap, and report validator, do not substitute these real observations, and do not grant official equivalence, hardware, performance, or compatibility with other engines or hosts.
