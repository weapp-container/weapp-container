# container-engine-quickjs

[简体中文](README.md) · **English**


Stable QuickJS adapter boundary with a batch module-loading API. Default CI builds
use the explicit metadata stub, which returns `NativeBackendUnavailable` from the
execution methods. Enable `quickjs-native` for the bundled QuickJS-NG runtime:

```bash
cargo test -p container-engine-quickjs --features quickjs-native
```

The native adapter applies memory/stack limits, installs an interrupt handler,
evaluates CommonJS-style modules in one batch boundary, calls global or module
exports with JSON value batches, and drains pending jobs. Its bootstrap exposes
the registration globals (`App`, `Page`, `Component`, `getApp`) and a
deterministic `wx` facade for storage, navigation, timers, capabilities and
`setData`. Side effects are queued and can be consumed with
`QuickJsEngine::drain_host_events`; host adapters should route those records
through the normal bridge/provider boundary. Unsupported APIs return a
structured `ERR_UNSUPPORTED_CAPABILITY` rejection and are never silent no-ops.
The runtime is thread-affine; hosts must proxy calls instead of moving it
between threads.
Mobile and Harmony targets may require `rquickjs/bindgen` plus the platform C
compiler and are validated separately by the host toolchain.

OpenHarmony has no bundled rquickjs binding for `aarch64-unknown-linux-ohos`;
use the explicit target feature and SDK toolchain when checking the provider:

```bash
ohos_sdk_native="$OHOS_SDK/openharmony/native" \
  cargo check -p container-host-harmony \
  --features harmony,quickjs-native-harmony \
  --target aarch64-unknown-linux-ohos
```

The repository `scripts/build-native-hosts.mjs` command supplies the target
compiler, archive tools, bindgen target/sysroot and host compiler variables so
QuickJS is never built from a host-ABI binding by accident.

Native timer polls use the shared timer scheduler with Unix milliseconds from
the host. Explicit zero is preserved; clocks must be non-negative safe integers.
Due timers run in deadline order, then registration order for ties. Each callback
is a separate native task with a Promise/microtask checkpoint before the next
callback, so cancellation from a callback or its microtasks takes effect before
the next timer. Timers created during a poll wait for a later poll, including
zero-delay timers created by promises. Overdue intervals coalesce to one tick
per poll and schedule their next tick relative to that poll's clock.

The default task budget is 1000 callbacks per poll; an optional second argument
to the internal `__container_drain_timers` engine call selects a budget from 1
to 1000. Exhaustion emits a `timer.yield` host event and retains pending timers
for the next poll. Callback and `queueMicrotask` exceptions enter the error queue
without discarding later tasks. Delays are truncated and clamped to
0–2147483647 ms; deadlines saturate at `Number.MAX_SAFE_INTEGER`. Timer callbacks
receive additional arguments and `globalThis` as their receiver. This budget
bounds callback count, not arbitrary synchronous JavaScript or an infinite
Promise chain; hosts still own execution deadlines and interruption.
