# Explicit Raster preview connection manager

`examples/hosts/web-wasm/dev-raster-preview.mjs` exports `DevRasterPreview` for
an explicitly configured `ticketed-raster-v1` developer surface. It does not
add an HTML route, static asset registration, CLI switch or default-policy
change. The ordinary simulator remains separate.

```js
const preview = new DevRasterPreview({ canvas, onState, onDiagnostic })
preview.connect()
// Explicit ownership transfer, only after confirming this actual connection:
await preview.claim()
// The caller owns input listeners and sends logical-coordinate event batches:
await preview.events(events)
preview.dispose()
```

`connect()` synchronously returns the manager; it may synchronously throw when
disposed or when constructing the EventSource fails. `disconnect()` is also
synchronous. `claim()` and `events()` return promises. `dispose()` closes its
terminal barrier and releases owned resources synchronously; it is idempotent.
Callers that normalize errors through promises should invoke operations inside
`Promise.resolve().then(() => preview.connect())`, or use `try`/`catch`.

The `onState` projection contains `phase`, `clientId`, `connected`, `owner`,
`inputEnabled`, `sessionId`, `pageId`, `configGeneration`, `previewEpoch`, and
`presentationTicket`. It never publishes the private connection token. Phases
include `connecting`, `waiting-init`, `confirming`, `owner`, `readonly`, the
presenter's drawing/ACK phases, `disconnected`, `error`, and `disposed`.
`connected` identifies an owned active EventSource instance, rather than
claiming that its private initialization or heartbeat has completed. `owner`
does not itself grant input: `inputEnabled` still depends on the exact final
presentation ACK.
Readonly `presentationTicket` metadata is projected only after its mirror RAF
draw returns, so the page can distinguish logical CSS dimensions from physical
pixel dimensions. This projection grants no owner binding or input authority.

## Actual connection and final heartbeat

Every `connect()` creates one actual EventSource at
`/api/events?clientId=...&since=0`. Every listener captures that source's local
connection object. Replacing it removes its listeners, aborts its requests and
closes that specific source. Old init, preview, final bridge, error and network
callbacks cannot act on its successor. An EventSource error closes and freezes
that instance; reconnection requires another explicit `connect()`, with another
private token. The manager does not let an opaque EventSource auto-reconnect
silently retain its previous authority.

The connection-private `preview-init` must have version1.0, this `clientId`,
`connectionToken`, and `committed:false`. It contains no owner epoch. Init,
public preview state, HTTP202 queued receipts and another client's final
responses do not establish authority. The manager sends a bound heartbeat to
`POST /api/preview`, preserving the original token and captured public epoch.
Only a matching final response with its original `requestId`, own `clientId`,
`ok:true`, unchanged actual connection/token and exact current heartbeat epoch
confirms the binding. Tokens are never parsed for internal serial numbers.
The preview HTTP response must be a queued receipt for that original request.
Even a correlated `ok:true` HTTP body is rejected as a protocol error; it never
enters the final-preview channel. That channel is fed only by the listener on
the actual current EventSource.

`GET /api/state` must advertise the exact developer profile and project the
original `devRaster.binding:{sessionId,pageId,configGeneration}` and public
`preview` state. State requests run serially. Replayed SSE state/preview bodies
only request another fresh GET; they do not overwrite the current page or
session with retained history. A different page, session, configuration,
preview epoch, owner or expiry freezes the old presenter, captures and input.
Frame order comparisons are confined to the current binding domain.

Heartbeats and state requests have local deadlines and bounded retry budgets.
Initial handshake failures retry after a short delay; exhausted budgets close
the owned EventSource. Normal heartbeat renewal retains the same proof and
accepted presenter binding while the request is pending. A failed renewal
freezes input before retry. Normal successful renewal does not synthesize a
View change, repeat business evaluation, or create another authority identity.
An explicit claim uses the same bound preview endpoint, then requires a new
final heartbeat before activating the resulting owner binding. Mirrors never
claim automatically.
Heartbeat interval plus two request deadlines must fit inside the advertised
lease, accounting for the previous final-response delay and the next renewal
deadline. Unsafe timing configuration is rejected explicitly.

Each actual final also commits a conservative local deadline calculated from
that control request's clock sample taken before sending, plus the advertised
lease duration. The original runtime's actual lease remains authoritative;
the local deadline can only stop input earlier. `owner`, `inputEnabled`, frame
admission, mirror RAF and the bridge send callback check elapsed time
synchronously, so suspended timer tasks cannot leave stale input enabled on
resume. A delayed final arriving after its own deadline cannot extend it.
An unchanged `expired:false` state or a finite clock sample cannot revive an
expired/rejected local proof; another actual final is required. Normal timely
renewal updates the local deadline without replacing the accepted proof or
presenter binding objects.

The injectable `clock` defaults to `Date.now()` and must return finite,
nonnegative elapsed milliseconds that advance while this document's timer
queue is suspended. Backward or invalid observations reject the current local
lease until a fresh actual final establishes another conservative deadline.
The clock is an embedding input, separate from virtual mini-program business
timers. A locally owned expiry timer performs proactive freezing and renewal,
while getters/senders remain independent of that timer executing. The page
still owns its visibility/BFCache policy; this local guard does not claim an
exact server clock or physical-screen completion.
`onState` is a notification snapshot, so a panel can continue showing its last
projection while timer and event tasks are suspended. It refreshes on the next
notification; it does not itself grant input. The synchronous `owner`,
`inputEnabled` and `events()` gates reject elapsed proof immediately when
called, including before that next UI update.

## Frames, readonly mirrors and input

The manager owns one logical frame acquisition slot with one newest pending
request. Owner fetches capture `presenter.captureFrameRequest()` before sending
and pass that exact capture to `offer(buffer,capture)`. Only binaryv2 with its
declared MIME is accepted. Responses whose actual source, local authority,
confirmed proof or owner role changed are discarded. A404 means no current
frame; another snapshot notification can request it again. All fetches use
`AbortSignal`; an injected custom transport that ignores cancellation may
continue its own underlying work, but its late result cannot be offered or
grant input. This is not a resource-release guarantee for arbitrary transports
that ignore their cancellation contract.
Transient frame failures also have bounded retries. Each retry explicitly
restores the same confirmed presenter binding before capturing another request;
it cannot depend on a coincidental later state or heartbeat notification.

Owners use `DevRasterPresenterClient` for decoder/RAF/exact ACK/input fencing.
SSE `bridge` batches feed its original `SseBridgeTransport.receive`. Event
batches delegate immediately to the presenter, capturing its already accepted
ticket and binding at API entry; the manager never awaits and then stamps old
input with a newer ticket.

A confirmed mirror uses the standalone decoder and a separate bounded RAF
slot. Its bytes must name the current session/configuration and public owner
epoch/id. It displays pixels without creating an owner binding, calling
`setBinding`, issuing an ACK or enabling input. Its RAF callback checks the
exact local capture again. Mirror and owner drawing observe Canvas2D draw
return only; neither claims compositor or physical screen completion.

`disconnect()` and `dispose()` abort state, frame and control requests; cancel
owned heartbeat/retry/timeout work and mirror RAF; retire presenter waits and
input; remove listeners and close owned sources. Disposal closes the terminal
barrier before invoking callbacks. It does not close unrelated browser tabs,
windows, servers or sources. The embedding page still owns its input listeners,
page/BFCache policy and any other UI resources.

## Validation boundary

Node definitions use injected EventSource, fetch, clock, presenter and RAF
fixtures. They cover connection/final-response correlation, stale work,
read-only mirrors, explicit claim, retry bounds and cleanup. They do not prove
a real TCP handshake, real browser draw/input, continuous gestures, compositor
completion, GPU performance, seven-host compatibility or goal completion.
The authored candidate has not itself been executed by its author; root owns
the test/compiler/browser lane and records exact execution separately.
