# container-sdk

[简体中文](README.md) · **English**


The native embedding boundary for Weapp Container. This crate owns a verified
portable pack, one real JavaScript runtime, navigation, asynchronous HTTP and
optional durable storage. Platform adapters own their UI surface and call the
SDK on one fixed thread. `ContainerSession` is deliberately neither Send nor Sync.

The default feature enables actual QuickJS. Builds without the requested engine
return `ERR_ENGINE`; they never run a metadata-only engine or choose a fallback.
Skia CPU, GLES, Metal and V8 have explicit Cargo features. Query `capabilities`
to distinguish compiled support from a currently attached/rendered GPU surface.

```rust,no_run
use container_sdk::{ContainerConfig, ContainerSession};
use serde_json::json;

let mut session = ContainerSession::new(ContainerConfig::default())?;
session.command("registerHostMethod", json!({"name":"account.current"}))?;
session.command("load", json!({"packPath":"/app/portable-pack"}))?;
session.command("pump", json!({}))?;
let events = session.command("takeEvents", json!({}))?;
# Ok::<(), container_sdk::SdkError>(())
```

Configuration uses camelCase: `engine`, `host`, `sessionId`, `storageKey`,
`storageRoot`. `host` carries the existing runtime host metadata including
`windowWidth`, `windowHeight` and optional complete `displayMetrics`. Default
logical dimensions are 375 × 667; native adapters must replace these with the
actual embedded view size before load. Omitted `storageKey` and `storageRoot`
select memory-only storage; provide both for persistence. Native SDK wrappers
should supply an application/account scoped stable key and app-private directory.

The internal command contract is shared by C/JNI/Swift/Dart bindings:

| Command | Payload / result |
| --- | --- |
| `load` | `{packPath, route?, options?}`; initializes a local unpacked directory |
| `lifecycle` | `{event:"show"\|"hide"}` |
| `navigate` | `{route, query?, replace?}` |
| `back` | `{}`; rejects popping the last page |
| `input` | `{events:[...]}`; one complete runtime input batch |
| `resize` | `{width,height}` in logical pixels |
| `windowMetrics` | Existing flat `HostWindowMetrics` JSON including DPR; also accepted before load |
| `inspectPackChrome` | `{packPath,route?}`; verifies and resolves static chrome without guest execution |
| `hostChrome` | Schema 1 measured capsule/content rectangles and monotonic revision |
| `setPreviewOccluded` | `{occluded}`; preview presentation/input independent of app foreground |
| `switchTab` | `{route}`; invokes runtime `wx.switchTab` |
| `sendMessage` | `{message:JSON}` to registered mini-program listeners |
| `registerHostMethod` | `{name}` before load; `wx.*` is reserved |
| `completeHostCall` | `{callId,result}` or `{callId,error:{code,message,retryable}}`; error codes are the runtime `ProviderErrorCode` wire values |
| `pump` | `{nowNs?}`; absolute Unix nanoseconds, default system clock |
| `state`, `capabilities` | Compact versioned JSON, without pixels or page data |
| `takeEvents` | Returns and drains the queued event array |
| `flushStorage` | Returns `{pending,ticket?}`; await `storageFlushed` event |
| `close` | Returns `{pending,ticket?}`; continue pumping until `closed` |

Events include `ready`, `navigation` with current page and stack, `frame` with a
monotonic revision, `hostCall`, `hostCallCancelled`, `message`, `error`,
`storageFlushed` and `closed`. Drain regularly; the bounded event queue reports
`ERR_EVENT_OVERFLOW` if a consumer falls behind. A frame revision is independent
from frame ID and changes for same-ID redraws and session replacement. Snapshot
pixels use observed DPR while input/layout retain logical pixels. Frame snapshots
are owned values and remain valid after the session is closed.

`load` validates manifest schema/integrity and every declared content-addressed
blob, including modern View/compiler closure, before startup. It starts a private
candidate and requires first-frame success before replacing the active runtime.
Candidate HTTP/business requests, messages and storage changes stay private;
failure leaves the original instance and frame intact. A successful replacement
retires the old instance and makes candidate storage authoritative; old unload
hooks cannot overwrite it. Remote URL loading and downloading executable updates
are outside this crate.

Exactly one native surface may attach. The low-level SDK rejects load/close while
attached. UI wrappers must drain GPU work, detach, perform load/close and attach
the surviving or replacement runtime. A failed load can reattach the preserved
old instance. Detaching does not unload or reset JS state.

The host must pump while hidden as well: HTTP, business completions, timeouts
and persistence barriers still settle. JavaScript timers, input and redraw pause
while hidden. Business continuations run only when the owner thread pumps or
completes a call. `wx.request` uses a separate reqwest/rustls executor, supports
HTTP(S), headers, JSON/text/ArrayBuffer, abort and deadlines, and limits requests
to 64 concurrent jobs, a 128-command transport queue and 8 MiB bodies. Each
accepted runtime owns a separate client, connection pool and executor; failed
startup preserves the live owner's pool, and same-user credential refresh keeps
it. Cancelled jobs retain capacity until their futures are joined. Up to eight
retiring network owners may await teardown; further loads apply backpressure.
Responses
do not enter JavaScript from the I/O thread. Upload/download/socket APIs are
explicitly unavailable. System/window metadata returns only known host fields;
unknown device, permission and account values are not fabricated.

Persistence uses a stable-key OS lock, one coalescing latest-snapshot slot and at
most 64 barriers. Writes atomically replace a file in the same directory and
sync it before completing a barrier. Snapshots preserve `undefined` separately
from JSON `null`. Write failures are observable through pump events. Async close
retains storage and managed-file leases until the request tasks, connection
pools and dedicated network executors have physically exited, then releases the
key lock before emitting `closed`. Account switching uses the same internal
drain barrier in addition to the native host's cleanup acknowledgement. Late
callbacks cannot enter the retired runtime. The typed Rust `flush_storage()` and `close()` methods are
explicit synchronous barriers for CLI/final native cleanup; UI flows should use
the nonblocking commands. Drop cancels I/O, retains account leases on the network
workers until their executors exit, and lets the persistence worker finish its
last accepted snapshot without blocking the UI, but cannot report failures;
explicit close is therefore required for observable durable teardown.

Retirement errors remain `type: "error"` and retain their original code and
message. `capabilities.diagnostics.retirementErrorOrigin.schemaVersion: 1`
advertises their additive ownership field:

```json
{"type":"error","error":{"code":"ERR_ENGINE","message":"..."},"origin":{"schemaVersion":1,"phase":"retirement","operation":"unload","sessionId":"old-session","acceptedPackIdentity":{"root":"<sha256>","acceptedPackRevision":"1","sessionId":"old-session"}}}
```

`operation` is `unload`, `cancelNavigation` or `cancelHostCalls`. The SDK freezes
this identity before teardown, so draining an error after a successful load
cannot attribute old cleanup to the new accepted session, including a restart
of the exact same pack root. Hosts may file such an error as historical only
after validating the complete versioned origin, both matching session IDs and
its distinction from the current accepted identity. It remains an observable
cleanup failure, not successful teardown. An absent, malformed, unsupported or
unattributable origin must keep the host's ordinary fail-safe error behavior;
never filter by `ERR_ENGINE` or discard all cleanup failures. Runtime errors
outside retirement do not acquire a retirement origin. Neither this diagnostic
metadata nor a successful pack acceptance proves GPU presentation.

Run `cargo test -p container-sdk` for real QuickJS pack, transaction, HTTP,
persistence and multi-instance contracts. These tests do not claim native GPU
surface or device certification.


<a id="宿主导航chrome"></a>
## Host navigation chrome

Preview.4 exposes the additive `chrome.protocolVersion: "1.0"` capability.
Use `inspectPackChrome` before launching guest code, then submit measured
`windowMetrics` and `hostChrome` before `load`. The public contract in
`sdk/contract/CONTRACT.md` defines coordinates and declarations.
`state.chrome` and chrome events carry resolved app/page configuration, per-page
dynamic navigation title/color, the actual page stack and system tabBar.
Hosts render this observation rather than reparsing app JSON. Actual capsule
geometry backs `wx.getMenuButtonBoundingClientRect`.

`setPreviewOccluded` revokes input/presentation while keeping the runtime's
foreground lifecycle, business timers and storage alive. A fresh accepted frame
and GPU presentation receipt restore input when the preview reappears.
