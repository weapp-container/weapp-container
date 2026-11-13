<a id="实际的-sse-连接和预览功能退役"></a>
# Actual SSE connections and preview retirement

[简体中文](sse-preview-binding.md) · **English**


This library-only primitive is disabled by default. The CLI and existing WebUI
continue using their original preview protocol. It binds real sockets; it does
not enable strict Raster HTTP input, frame-v2 or browser RAF acknowledgment.

Create a pristine normal WebSurface, call `enable_sse_preview_binding()`, then
accept `GET /api/events?clientId=owner` (optionally `&since=...`). Resource-only
or control surfaces cannot opt in. Every admitted socket receives its own
`preview-init` event with no event ID. The bounded JSON contains version1.0,
clientId, a fresh connectionToken and committed:false. This event never enters
the common event history, Last-Event-ID replay, another socket, state or Debug.
The token combines getrandom256 entropy and a non-reused surface connection
serial. Serial/entropy/capacity failure rejects admission; no old token is reused.

The host drives `poll`, then the same owner's `handle.resolve_preview_controls`
callback, then `wait`. That callback receives a borrowed private-field
PreviewRetirement; it must retire the ORIGINAL runtime with
`simulator.retire_dev_preview(retirement.reason())` and propagate failure.
Successful callback return is recorded internally, the actual connection and
queue head are checked again, and only then is the existing PreviewState owner
committed. Returned private-field PreviewControlReceipt values describe applied
or stale controls, never presentation success. No request-body constructor can
create internal socket controls or a retirement receipt.

For exact Raster presentation, enable_dev_raster_presentation must run before
app.init. retire_dev_preview cancels software/browser contacts and scroll touch
positions in one trusted engine turn, drains storage/effects and revokes exact
authority again after callback effects. A callback or turn-completion failure
returns Err and retains diagnostics. The existing browser-only retirement API
and Legacy Raster's automatic presentation policy retain their old semantics;
this primitive does not turn legacy readiness into strict evidence.

In bound mode `/api/preview` accepts existing1.0 claim/heartbeat/release fields
plus connectionToken. Its JSON body is limited to1024 bytes. It captures the
already committed live socket binding and rechecks it when the owner consumes
the FIFO. Actual socket admission alone supplies connect. expire/disconnect
are private controls and cannot be injected through HTTP. Existing PreviewFence
still has no token; strict bridge/input admission is separate work.

There is one PreviewState, one owner/epoch and the original32-control FIFO.
Each admitted SSE socket consumes one queued connect and reserves one future
retirement place. EOF/write failure/explicit close/Drop converts that obligation
to a typed queue entry; it is not free capacity until the owner consumes it.
The original16-SSE and64-HTTP caps are unchanged. A single current-epoch
retirement checkpoint freezes old owner proofs across a failed callback and
records a completed callback if reentry kills the proposed successor. No old
authority revives and cancellation is not replayed. The old/new sockets may
temporarily coexist, but only one binding commits as primary. Late old EOF is
matched by actual connection identity and cannot revoke a newer connection.
If a proposed successor dies after retiring the current epoch, the still-live
owner may explicitly claim using its current connection token. This advances
to a fresh epoch; it never revives a previous lease proof. Completed retirement
is reused without another callback; an incomplete attempt must succeed first.

Callbacks, socket writes, pending payload destruction, evicted replay WebEvent
owners and DomRetirement release occur after unlocking. The common publish
routine's optional retirement collector moves full evicted events out of the
critical section for this owner consumer. Unrelated legacy publish and the
previously documented DOM resolver/predicate lock boundaries are not expanded
into a new guarantee. Poison recovery queues cleanup metadata only; normal
owner execution on a poisoned store remains unavailable.

Graceful shutdown calls close_event_streams, drains resolve_preview_controls
on the original owner lane, then drops the surface/runtime. Surface Drop closes
its sockets before Shared can disappear, so an existing external handle can
still drain retirement work. Dropping the final surface and handle without an
owner drain cannot execute runtime cleanup automatically. Epoch exhaustion can
leave a completed retirement pending a new surface/session; it never wraps or
silently reassigns ownership. The owner must handle the returned error.

The source includes real TCP consumers for private init/replay, reconnect and
late EOF, close-before-connect, bounded cleanup obligations, wire ordering,
same-epoch mirror reconnect, callback failure/unwind/reentry, write failure,
poison, Drop, expiry and identity exhaustion. A native QuickJS/V8 consumer uses
the same Simulator and its exact Raster lease; its explicit Rust ACK is a
library test action, not a browser RAF receipt. Runtime tests cover actual
touchcancel, hook navigation/error, QuickJS timeout and orphan scroll capture.
All are definitions until the exact integrated commit is compiled and executed.
No active service, browser/GPU/device/performance/DevTools/seven-host or goal
completion is established by this source change.
