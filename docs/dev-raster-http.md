# Explicit developer Raster HTTP owner

`container_simulator::web::DevRasterWebSession` is an opt-in library owner for
one original `Simulator` and one actual `WebSurface`. It connects the existing
explicit developer Raster policy, actual SSE connection ledger, immutable binary
frame v2 publication, runtime-issued presentation tickets and original runtime
ACK/input lane. It creates no second Session, owner ledger or Web thread.

This slice does not enable the normal simulator CLI or change headless defaults.
The explicit owner serves a separate experimental browser UI at `/`, with the
binary decoder, RAF presenter and connection manager as local module assets.
It provides connection state, explicit primary-preview claiming, disconnect and
tap input. Continuous gestures and settings controls are not implemented here.
The ordinary surface continues serving its existing UI. Raster means the selected software
surface here; neither HTTP delivery nor a Canvas2D RAF draw return proves GPU or
compositor presentation. Browser, performance, GPU, native host and device gates
remain separate.

## Explicit entry

```rust,no_run
use container_simulator::{SimulatorConfig, web::DevRasterWebSession};
use std::{net::{IpAddr, Ipv4Addr}, time::Duration};
# fn main() -> Result<(), Box<dyn std::error::Error>> {
let mut owner = DevRasterWebSession::bind_from_pack_dir(
    "target/reference-pack", SimulatorConfig::default(),
    IpAddr::V4(Ipv4Addr::LOCALHOST), 0,
)?;
println!("{}", owner.url());
owner.poll(0, true)?; // production clock is Unix nanoseconds, not this example 0
owner.wait(Duration::from_millis(10))?;
let cancellation_effects = owner.shutdown()?;
# let _ = cancellation_effects;
# Ok(())
# }
```

For a separately owned experimental process:

```sh
cargo run --release -p container-simulator --example serve_dev_raster -- \
  --pack target/reference-pack --port 0 --duration-seconds 60
```

The example reports its own address, explicit profile and attached experimental
UI. This source wiring alone does not establish a successful browser run.
No existing simulator, port or browser is replaced. Engine
features remain explicit; unavailable QuickJS/V8 combinations return the
existing engine error. `PageRenderMode::Raster` is required. Effective WebView
routes are rejected before this owner starts or accepts a replacement pack;
an explicit existing Skia override is honored.

Only immutable packs owned by the caller should be passed to
`apply_dev_pack`. It validates the candidate before invoking the original
reload path. WXML/style updates retain its existing in-place policy; module or
configuration updates use its checked restart identity and preserve explicit
Raster policy. It publishes new original trace response batches and a `reload`
report. Truncated original trace coverage emits an explicit diagnostic and
cannot be treated as complete effect evidence.

## Actual connection and wire

1. Open `GET /api/events?clientId=<bounded-id>&since=0` and retain that actual SSE
   socket. Its private `preview-init` contains `version`, `clientId`,
   `connectionToken`, `committed:false`. It contains no epoch and is never put
   in global state/replay.
   This strict profile accepts only 1..128 ASCII letters, digits, hyphens and
   underscores for `clientId`. The SSE endpoint rejects other ids before any
   owner admission; legacy preview identifier rules remain unchanged.
2. Read public `state.preview.epoch`. After the runtime owner consumes the
   connection, submit an exact token-bound `/api/preview` heartbeat:

   ```json
   {"version":"1.0","requestId":"confirm-1","clientId":"preview-1","op":"heartbeat","epoch":"1","connectionToken":"<actual-private-init-token>"}
   ```

3. HTTP 202 only confirms queuing. Wait for the matching final SSE `preview`
   event with `ok:true` before using that actual binding. A new token is not
   committed merely because a public owner id matches. Mirrors confirm their
   connection without implicitly claiming input.
4. `GET /api/frame` returns `application/vnd.weapp.frame.v2`: a little-endian
   `u32` metadata byte length, UTF-8 JSON metadata and RGBA bytes. Every runtime
   identity in v2 uses canonical decimal strings. Use its unmodified
   `presentationTicket`; do not rebuild it from public frame values.

Strict bridge single requests are standard protocol 1.0 request envelopes with
one outer `preview:{clientId,epoch,connectionToken}`. Batches are
`{preview, messages:[...envelopes]}`. Per-message fence overrides and unknown
envelope fields are rejected. The initial operation allowlist is
`dev.raster.presented`, `event.batch`, `diagnostic`.

ACK payload:

```json
{"presentationTicket":"<the original ticket object>","draw":{"endpoint":"canvas2d-raf-draw-return"}}
```

The placeholder above denotes the original object, not a string to send. The
draw object accepts exactly that one endpoint field. ACK cancellation/deadline
metadata is explicitly unsupported in this first profile. Input payloads add
the same ticket alongside `events` and `logicalViewport:{width,height}`. The
viewport must match the logical ticket dimensions and the exact lease must
already have completed its runtime ACK.

Every envelope executes on the original owner lane and revalidates its actual
connection `Arc`, owner epoch, original runtime current ticket and immutable
cached v2 publication. An earlier ACK may navigate, throw or otherwise retire
the basis; a later envelope in the same body must then fail closed. Session,
generation, frame, EOF and reconnect changes never revive old input.

HTTP 202 means queued. The final SSE `bridge` event is a standard correlated
`BridgeBatch`: response kind, same session/request/op. ACK success echoes the
exact `presentationTicket` and an `inputEnabled` boolean rechecked after hooks
finish. Typed runtime ACK errors become `ok:false` correlated errors; they do
not leave callers waiting for a response that can never arrive.

If publication succeeds and a ready/observer effect then fails, the final is
`ok:false, committed:true`. It retains the exact ticket, current input state,
the original error code and its phase; the error's request id is correlated to
the ACK. The original diagnostic/effect batch remains intact. This final does
not roll back accepted pixels or JS side effects. A duplicate of a still-current
ticket acknowledges the existing publication without rerunning its hooks; a
retired ticket remains rejected.
Typed terminal errors take precedence over earlier raw JS diagnostics. A
restart requirement remains explicit and disables input in the final; all
original diagnostics retain their order in the batch.
Preview retirement revokes the old receipt while retaining a current manifest
scene's provenance and pending ready work. A fresh accepted ticket may finish
that work once; old receipts and manual frames cannot grant ready authority.

## Limits and cleanup

The existing 64-request / 8 MiB bridge queue is reused. Each strict body has at
most 16 unique bounded request ids; session/request/trace/cancel metadata is
bounded before any VM execution. Admission proves the complete minimal
correlated failure batch fits a reserved final budget. The owner consumes at
most four request bodies per poll, while original timer semantics continue.
The initial session id is at most 228 UTF-8 bytes, reserving room for the
original checked `-reload-<u64>` suffix within the 256-byte frame identity limit.

Each final event is limited to 256 KiB within the existing 2 MiB SSE replay
budget. An oversized result retains correlation with `ERR_RENDER` and
`operationMayHaveCommitted:true`; it does not claim rollback or rerun the
operation. Runtime effects were recorded at their original boundary. The
original development trace is bounded to 1,024 records / 8 MiB; callers must
inspect `trace_summary()` for retention loss. SSE replay remains bounded, and
slow readers must honor existing replay reset behavior.
Natural lease expiry or actual EOF between a control turn and publication
leaves publication pending and is retired on the next original owner poll; it
does not stop the service. Renderer, allocation/budget and engine failures
still return errors. Untyped transport failures use a stable `ERR_*` code.

Legacy callbacks, raw queue drains, old `/api/render-presented`,
`/api/render-frame` and presentation mutations cannot bypass this profile.
`GET /api/presentation` remains read-only; mutation explicitly returns
unsupported. The default transport is unchanged without this library opt-in.

Call `shutdown()` explicitly. It first closes this owner's real sockets and
listener, then consumes actual EOF retirement on the same original runtime and
returns cancellation effects. If a hook fails, input stays revoked, the port
stays released, the original Session diagnostics remain available through
`drain_diagnostics()`, and shutdown may be retried. `Drop` only closes owned
sockets before dropping the runtime; it deliberately executes no arbitrary JS
while unwinding and does not claim delivery of cancellation effects.

Source-defined tests cover owned TCP/SSE, real runtime hooks and failure paths.
They do not replace executed compiler/test reports or browser/GPU evidence.
