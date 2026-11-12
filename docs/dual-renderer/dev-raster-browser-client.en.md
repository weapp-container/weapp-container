<a id="有票位的位图浏览器原语"></a>
# Ticketed Raster browser primitives

[简体中文](dev-raster-browser-client.md) · **English**


`examples/hosts/web-wasm/dev-raster-frame.mjs` decodes binary frame v2 with a
4096-byte metadata limit, 16 MiB pixel limit and 4096-pixel physical edge limit.
It checks every duplicated identity and dimension against the nested runtime
ticket. Identities remain canonical decimal strings throughout comparison,
including the full `u64` range. The immutable metadata does not grant runtime
authority. Pixels are a straight RGBA view into the received buffer; the decoder
does not copy the whole frame or premultiply its colors again. JSON metadata is
validated after standard `JSON.parse`; this is not a duplicate-key-rejecting or
canonical-JSON parser.

`DevRasterPresenterClient` in `dev-raster-client.mjs` is an opt-in Canvas2D
transaction library. Its embedding owner must manage the actual SSE connection,
frame requests and the final bound-heartbeat handshake. Only after a matching
final heartbeat result confirms the exact connection token and epoch may it
call `setBinding({sessionId, pageId, configGeneration, clientId, epoch,
connectionToken})`. `preview-init`, global preview metadata and HTTP queued
receipts cannot establish that binding. These primitives do not modify the
ordinary simulator UI, CLI or default synchronous Raster policy.

The owner calls `captureFrameRequest()` before starting each frame fetch, then
feeds its response through `offer(buffer, originalCapture)` and SSE bridge batches
through `receive(batch)`. Captures preserve the original local binding reference;
late fetches cannot adopt a newer page or connection token even when other wire
values coincide. They are local scheduling facts, not socket authority or wire
identities. New frames disable input before being queued. A single
RAF callback draws the latest pending frame, then requests
`dev.raster.presented` with the original ticket and
`draw.endpoint = "canvas2d-raf-draw-return"`. Input opens only after a correlated
final response returns that same ticket and `inputEnabled: true`, while the
binding and latest frame remain current. This endpoint observes a Canvas2D call
returning inside RAF; browser compositor completion and screen presentation are
unmeasured.

The Raster send adapter accepts only an HTTP `{queued:true}` admission receipt
or a transport failure. Even a perfectly correlated HTTP response containing
the exact ticket cannot complete an ACK or input request. Finals must enter
through `receive(batch)` from the embedding owner's current actual SSE stream.
The adapter returns its own immutable receipt instead of passing the original
HTTP object to the shared transport. This Raster-specific boundary preserves
the generic transport's legacy support for complete HTTP response batches.

`events(events)` uses the accepted original ticket, logical viewport and captured
connection binding. The send microtask rechecks that capture before transmitting;
it never fills in a successor connection token. The server must independently
revalidate the actual connection, current owner and runtime ticket immediately
before each operation. A queued input may have committed effects before a later
disconnect; cancellation does not promise to roll those effects back.

Call `disconnect()` on EOF, EventSource failure, owner loss or an invalidated
binding, and `dispose()` when removing the client. Session, page, configuration,
owner epoch or token changes invalidate pending drawing, ACKs and input. A timeout
leaves input disabled. `retryPresentation()` permits an explicit bounded retry
with the same issued ticket and a new correlated request id; it never starts an
automatic retry loop. Each client retains at most the active and latest pending
frame references. The owner remains responsible for a bounded single in-flight
frame fetcher and exact cleanup of its own SSE/browser resources.

Node contracts cover framing, UTF-8 and integer bounds, immutable tickets,
coalescing, queued/final responses, stale work, input fencing and cleanup. They
inject already committed bindings and do not prove a real socket handshake,
browser rendering, GPU completion, performance or any platform release gate.
