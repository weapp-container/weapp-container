<a id="性能实现范围"></a>
# Performance implementation scope

[简体中文](performance-implementation-scope.md) · **English**


The runtime implements synchronous `wx.getPerformance()` and its realm-owned
`Performance`, `PerformanceObserver` and observer `EntryList` objects against
the locked `miniprogram-api-typings@5.2.3` API shape. This is a partial metric
scope; it is not complete WeChat performance compatibility or device acceptance.

Both real engines use a captured native monotonic clock in milliseconds:
`std::time::Instant` on native hosts and `web_time::Instant` in QuickJS/WASM.
Time zero is the AppService engine's performance-clock installation, after VM
creation and before trusted bootstrap execution. The temporary clock global is
removed before application code. Guest `Date.now`, `Math.max`, Promise species
and replacement clock globals do not control the private measurements.

Implemented measurements:

- `script/evaluateScript` surrounds successful execution through the runtime's
  named-module evaluator. `fileList` contains the actual evaluated manifest
  path. Nested dependencies have separate samples. Failed evaluation produces
  no completed-script sample. Legacy unnamed module loading and compilation
  before factory execution are not measured.
- `navigation/appLaunch` records elapsed time from this clock origin to the
  first successful `onLaunch` lifecycle return. Its path is the actual launch
  argument when supplied, captured before the application hook can mutate it.
  This scope excludes package I/O, native VM creation,
  and subsequent rendering; it must not be used as an end-to-end cold-launch
  benchmark. Repeated hook invocations do not invent a second launch.

Route processing, render/first paint, resource timing and package downloading
are not instrumented. They do not appear in `supportedEntryTypes`; attempting
to observe them fails with `ERR_UNSUPPORTED_CAPABILITY`. Script `moduleName`
is omitted until the runtime supplies verified package ownership. A future
runtime implementation must supply actual start/end boundaries and fields
before claiming those scopes.

The timeline defaults to 30 entries. `setBufferSize` accepts integer sizes from
0 through 4096 and immediately keeps the newest entries when shrinking; size 0
disables timeline retention while active observers still receive new samples.
All lists are sorted by measured start time. Public snapshots copy entry
records and file lists, including each call on a retained observer `EntryList`.
Internal queues and metric records have isolated prototypes. Public snapshots
retain normal Array interfaces, with indices and entry fields created as own
data properties so guest prototype setters cannot corrupt collection or skip
a neighbouring observer. Measurement failures are reported as diagnostics;
they preserve the application hook or module evaluator's actual result or
exception.

Observers accept exactly one of `type` and `entryTypes`; empty or unsupported
filters are rejected without changing an existing subscription. Active
observers are capped at 256, and each observer has a bounded 4096-entry queue.
Overflow discards the oldest samples. Delivery batches run at the native
microtask checkpoint. Disconnect/reobserve invalidates pending and detached
batches, and a throwing callback does not skip another observer. Observers are
global to the AppService realm and are collected when that native owner is
destroyed; they do not move to a replacement engine after an account change.

`getPerformance` and operations on existing Performance/Observer/EntryList handles obey
the current capability gate. Turning the capability off drops pending observer
delivery. `disconnect` always remains available for cleanup.

The shared real QuickJS/V8 regression fixture covers synchronous filtering,
native elapsed time, bounded buffering, snapshot isolation, checkpoint batching,
disconnect races, unsupported metric rejection, failed modules, launch/owner
isolation, capability revocation, guest prototype mutation and pre-hook launch
path snapshots. These finite engine tests do not replace
fresh-archive public SDK or seven-platform acceptance.
