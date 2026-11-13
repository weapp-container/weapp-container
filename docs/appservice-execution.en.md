<a id="appservice-执行时限"></a>
# AppService execution time limit

[简体中文](appservice-execution.md) · **English**


Hosts can set time limits for QuickJS startup and each host operation via `SessionConfig.engine_execution`:

```json
{
  "engine": "quickjs",
  "engine_execution": {
    "bootstrap_timeout_ms": 5000,
    "turn_timeout_ms": 250
  }
}
```

Both fields are optional integers, accepting 1–86400000 milliseconds. The default is `null`, which retains the time-limited policy of the existing host. These values ​​are configuration examples, not frame rate or performance acceptance metrics. Worker hosts that require a limited execution policy must set both fields explicitly. Builds with V8 and uncompiled QuickJS providers reject the limited strategy, returning `ERR_ENGINE`.

A host operation uses the same monotonic clock deadline. Module registration and evaluation, callbacks, result serialization, exception reading, microtasks, storage and capability synchronization are all included. Multiple requests to `dispatch_batch` share the outer deadline; nested calls and request deadlines can only shorten it. Timers, resize, network notifications, rendering confirmations, browser events, touch cancellation and development replacement also pass through this boundary when calling `Session` directly. The absolute deadline for development candidates to share operations with the current Session; View evaluation and scope release only obtain the remaining budget.

Ordinary synchronization exceptions still execute microtask checkpoint within the same operation, and retain the original exception and the effects that have been generated; Promise cleanup will not be postponed to the next request. When checkpoint times out or is canceled, execution faults will be returned first and subsequent JS cleanup will be stopped. QuickJS and V8 share the common exception checkpoint distribution path; this does not mean that V8 already supports limited execution strategies.

QuickJS interrupt handler detects deadlines and engine-level cancel flags. The first interruption retains `ERR_TIMEOUT` or `ERR_CANCELLED`; the failed realm can only be replaced by a new Session, and subsequent executable requests return `ERR_ENGINE`. The error response contains `requiresRestart: true`, `Session::execution_fault()` returns the first failure. The error string with the same name thrown by the user cannot be regarded as an engine interruption.

Engine-level `EngineExecutionBudget.cancellation` accepts `Arc<AtomicBool>` held by the host. The current Session's `cancelToken` only checks request admission and Provider cancellation, and does not expose a handle that can cancel AppService from another thread during execution; these two capabilities cannot be confused.

Do not perform application error handling, rollback, effects drain or unload hook after interruption. Input, geometry and pending rendering authorizations are revoked at runtime; the old screen is only used for diagnostics. Events that have been consumed by Rust remain in the response batch, and unconsumed JS queues are no longer executed. `cancel`, `diagnostic`, `error` control messages are still available; `diagnostic` responses contain fault and restart requests. The host should recycle the failed instance using `HostSession::unload` or release the Session rather than sending a lifecycle unload that would execute application code.

`app_service_mut()` Keep the original Rust API: contact retirement before lending is subject to time limits, failures remain in the Session and diagnostic flows; getting a native state reference does not restore JS execution permissions. Rendering magnification and GPU submission of accepted frames do not execute JS and do not create new application operations.

This is not a hard real-time sandbox: synchronous Rust Provider, allocator, GC, and compiler native work are not guaranteed to be immediately preempted by interrupt callbacks. The queued Worker `postMessage(cancel)` cannot interrupt the running synchronous WASM; the Worker host also needs to have an independent watchdog and terminate the Worker it created after the normal shutdown timeout. Force termination does not guarantee application unload, storage flush, or session preservation.

The return entries are `container-engine-quickjs/tests/appservice_deadline.rs`, `container-runtime/tests/appservice_turn_budget.rs` and `container-runtime/tests/appservice_exception_checkpoint.rs`. Infinite execution use cases use respective child process watchdogs; these local contract tests are not a substitute for actual WASM Workers, GPUs, official DevTools, devices, or performance evidence.
