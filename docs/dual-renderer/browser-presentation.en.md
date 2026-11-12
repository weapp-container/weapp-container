<a id="浏览器呈现-v1"></a>
# Browser presentation v1

[简体中文](browser-presentation.md) · **English**


This owner-thread protocol connects evaluated `ViewDocument` values to real DOM
layout. It is an implementation milestone, not a seven-host, performance or
WeChat parity result. The development CLI attaches this protocol for
`--surface web --renderer webview --web-runtime remote`; its tests and evidence
are separate from the verification-only JSONL driver.

<a id="所有权和事务"></a>
## Ownership and transaction

Hosts explicitly enable `SessionConfig.browser_view_enabled`. Page profile
selection still comes from the negotiated manifest or the host override.
Application modules, View evaluation, component ownership and event listeners
remain in the runtime. The browser owns layout, hit testing and native scrolling.
DOM preparation does not cascade styles in Rust, decode images into the Skia
cache, run Taffy, commit a Skia page or read page pixels.

Bridge operations use `HostSession::dispatch` / `dispatch_json` on
the runtime thread. They inherit bridge session/protocol validation, deadlines,
cancellation, storage synchronization and failure-path effect draining. The
lower-level `Session` presentation methods are transaction primitives; a host
must not use them as an alternative JavaScript turn boundary.

The simulator's owner thread also calls `HostSession::retire_browser_preview`
when a preview lease changes. This host boundary cancels captured touches,
revokes presentation authority and drains callback effects before a fresh
document request is published. It does not background AppService or stop timers.

<a id="开发预览版所有权"></a>
## Development preview ownership

`POST /api/preview` accepts `{version,requestId,clientId,op,epoch?}` for
`connect`, `claim`, `heartbeat` and `release`. HTTP 202 is admission only;
the `preview` SSE event is the owner-thread result. The lease lasts 15 seconds
and previews heartbeat every 5 seconds. Owner changes, expiry and owner
reconnection retire runtime authority before advancing the canonical decimal
epoch and surface generation. `viewAuthority.previewEpoch` binds a state
publication to its lease; a preview result cannot activate an old authority.

Release and expiry remain available after a DOM-to-Skia switch. Retired release
receipts are bounded and cannot revoke a later owner. A readonly client that
reconnects with the same client ID in an unchanged epoch can have its subsequent
release classified as a duplicate; its record then expires at the 15-second
TTL. New surface instances use new IDs. This is a bounded cleanup delay, not an
immediate-release guarantee for that reconnect case.

DOM bridge requests carry a host-only top-level
`preview:{clientId,epoch,requestRevision?}`. Every `view.*` envelope is fenced at
HTTP admission and again immediately before dispatch. `view.prepare` must also
match the immutable latest request revision, render payload and generation.
The revision is captured when the browser initiates preparation, not sampled
from a later mutable state. This metadata never enters the runtime protocol.
DOM presentation settings require the current owner fence too.

Only the owner performs runtime preparation, geometry updates or input. Mirrors
locally display the runtime-accepted document with input disabled. A transfer
requires a fresh transaction before enabling the new owner's input. No tab can
revive an old presentation by reusing a page ID. Encoded image resources are
authorized by complete presentation key and hash, shared across in-flight
responses, and charged to the Web cache budget until the last response releases
them. Clearing a cache does not make still-retained response buffers free.

View request changes must notify the browser even when a timer turn returns an
empty bridge batch. Requested state and confirmed state are tracked separately:
ready-triggered `setData` queues another revision instead of being marked as
already rendered. Density changes keep the accepted document; logical resize
and successful in-place reload schedule fresh layout. Browser-only CSS or
decode failure can still occur after Rust reload preflight; the prior image is
retained and invalid input stays suspended. Full browser preflight before live
manifest replacement remains a separate implementation requirement.

| Operation | Request payload | Successful response payload |
| --- | --- | --- |
| `view.prepare` | `{version:"1.0",surfaceGeneration:"1",render:{templateId,viewport,useSessionResources:true}}` | `{ok:true,submission:{version,key,viewport,document}}` |
| `view.prepare.commit` | `BrowserGeometryBatch` measured in a hidden prepared DOM candidate | `{ok:true,permit:{version,key,epoch,permitId}}` |
| `view.presented` | The exact permit, after the browser commits its candidate | `{ok:true,key,inputEnabled}` plus lifecycle/effect diagnostics |
| `view.abort` | The exact pending `PresentationKey` | `{ok:true}` |
| `view.geometry` | `BrowserGeometryBatch` for the accepted document | `{ok:true}` |
| `view.events` | `{version:"1.0",key,epoch,events:[...]}` | `{ok:true}` plus consumed/dropped counts, effects and diagnostics |

The sequence is prepare document → hidden DOM/layout → runtime permit → browser
commit → runtime ACK → browser confirm. A queued HTTP response is not a permit
or final ACK. The browser retains the prior document and its resources until
confirmation. Once the runtime acknowledges publication, a failed ready hook
does not roll metadata back. `inputEnabled:false` confirms the displayed document
while keeping input suspended; recovery needs a new valid transaction.

`PresentationKey` binds session, page, document revision, presentation revision,
surface generation and profile. Every u64 in this protocol uses a canonical
decimal string. The older `ViewDocument` v1 numeric identities are admitted only
within JavaScript's safe integer range. Geometry must contain exactly the
authoritative document occurrences, including text nodes. A duplicate epoch is
idempotent only when its complete contents match; a changed batch requires a
strictly newer epoch.

<a id="输入和退役"></a>
## Input and retirement

Browser events carry `type`, `targetOccurrenceId`, `detail`, optional `timeStamp`,
`touches` and `changedTouches`. Each touch carries `identifier`, `x`, `y`,
`clientX`, `clientY`, `pageX`, `pageY`. Coordinates and times must be finite;
identifiers must be safe integers and unique within each bounded touch list.
The runtime derives handlers, propagation path, catch policy, component owner,
dataset and mark from its immutable evaluated topology. The wire does not
accept these as host authorities. A whole batch is validated before callbacks.
Each event's effects are applied before admitting the next event, so navigation
cannot leave subsequent input addressing an old page. Callback failures retain
committed data/storage effects and consumed/dropped receipts.

Consumed `touchstart` events acquire an owned contact with the original event
topology and latest coordinates. A terminal event consumes that ownership before
callbacks, and late terminal events cannot replay it. Before reconstruction or
lifecycle retirement, the runtime sends one synthetic cancellation to the
original receiver, preserving callback effects and diagnostics even on failure.
Full DOM reconstruction currently ends gestures; continuous gesture migration
across documents is still pending. Render requests should use authoritative
page data, rather than supply a snapshot captured before cancellation hooks.

Manifest replacement, logical resize, page hide/unload, app hide/unload, component
graph invalidation/disposal and unrestricted host store mutation retire old
authorizations. Returning to the same cached PageId, dimensions or manifest
cannot revive them. Background/destroyed applications cannot prepare a new
presentation. The last image may remain available for diagnostics while input
and geometry access are suspended. Legacy `render.commit` and numeric Skia ACK
cannot publish a WebView page or prematurely fire ready.

The browser client admits one geometry request and one newest pending geometry
job. Events remain attached to their admitted epoch and wait for its ACK, with a
256-event budget. Locally retired work is discarded without an error overlay;
actual runtime failures remain errors. Exact-request timeout tombstones are
bounded and can only abort a late pending candidate. After final ACK, cleanup
failure preserves the new image and suspends input; it cannot restore the old
surface or let a delayed timeout undo publication.

<a id="资源和剩余适配器"></a>
## Resources and remaining adapters

`HostSession::browser_view_resource(key, sha256)` exposes borrowed encoded bytes
only for assets declared by that pending/accepted document. Knowing an internal
script or stylesheet blob hash does not grant access. The transport must retain
immutable resource leases and enforce byte/cache budgets independently from
frame metadata.

Browser-backed SelectorQuery now has a partial adapter gated by explicit
recipient negotiation; it matches the evaluated document and requests a fresh
browser measurement rather than reusing accepted input geometry or an old
Skia frame. Worker startup can opt in before `app.init`; Remote initial
`onLoad` has no recipient and remains unsupported until the preview's actual
presentation handshake. See [DOM query negotiation and evidence](browser-selector-queries.en.md).
Intersection observers and scroll commands still require dedicated DOM
adapters and return structured unsupported errors. None of these paths may
borrow the previous Skia page's geometry.

Media queries use positive host logical viewport dimensions without waiting for a
DOM candidate or final ACK. They never fall back to a previous Skia frame. Unknown
host dimensions retain pending observations until valid metrics arrive; density
and display-only changes do not produce logical media transitions. Existing
observer ownership, hidden-page subscriptions, disconnect and disposal rules are
shared by both profiles.

`Session::browser_page_input(key)` exposes local root-data provenance for an exact
live candidate or accepted presentation. The snapshot is captured when page data
is cloned, after any contact-cancellation re-read, and is not upgraded by later
component hooks, ready callbacks, geometry updates or ACKs. Explicit render data
and detached previews do not receive a page snapshot. This lets the simulator
avoid redundant redraws while retaining updates written after the root snapshot.
It is not a presentation permit or an asynchronous observation lease.

`pnpm host:webview:media-smoke --binary <simulator> --engine quickjs|v8 --out
<new-directory>` runs a watch-built reference-app copy in one owned headless
browser. It checks the rendered media callback, logical resize, unchanged
dimensions, render-scale changes and disconnect. Reports retain the fixture,
portable pack, binary/source hashes and cleanup outcomes. Actual browser DPR
transitions, official behavior and performance remain separate gates.

Local fault-injection tests and the protocol example are auxiliary evidence.
Native WKWebView/WebView2/WebKitGTK/Android WebView/ArkWeb, browser Worker mode,
mixed components, official oracles and hardware/performance gates remain in the
frozen goal scope.

<a id="运行协议示例"></a>
## Running the protocol example

Build `container-host-common`'s `dom-protocol` example with
`--features container-runtime/quickjs-native,container-runtime/v8-native`.
It reads an existing portable pack with `--pack <directory> --engine quickjs|v8`,
verifies its manifest and blob hashes, initializes the real application, and
keeps `HostSession` on its stdin/stdout owner thread. Its first JSON line is
bootstrap metadata; subsequent lines are complete bridge request/response
envelopes on stdin and response batches on stdout. It does not expose an HTTP
server or attach to a user's browser.

The companion test runs an owned temporary HTTP server and headless Chromium:

```sh
node scripts/dom-runtime-browser-smoke.mjs \
  --pack <portable-pack-directory> \
  --driver target/debug/examples/dom-protocol \
  --engine quickjs --out artifacts/dom-runtime-quickjs
```

Use the reference or modern View example pack, which exposes an `increment`
button and a numeric `count`. The test records actual DOM geometry, screenshots,
bridge/lifecycle traces, input effects and absence of a Skia page frame. It
closes its own browser, server and runtime process on success and caught failure.
Forced termination and signal-interruption recovery are not covered by this
smoke. Use a fresh
output directory for every run so failed evidence is retained.

`pnpm host:webview:test` runs the browser transaction and transport unit tests.
The existing `modern-view` CI job builds both real example packs and runs the
protocol example on QuickJS and V8. A workflow definition is not CI execution
evidence; runner results are recorded separately.

<a id="开发-监督器集成"></a>
## Development-supervisor integration

The development supervisor chooses the current page's profile when preparing
its render request and applying a pack. DOM preparation reads current page data
on the runtime owner thread. A final ACK can run ready hooks that change data;
the resulting revision generates its own render request.

The owner loop and bridge SSE transport DOM operations separately from
CanvasKit's numeric ACK path. Shared server state exposes the actual page
profile and string-valued authority identity. Encoded DOM resources use a
separate endpoint and share the bounded cache budget with in-flight responses.
Profile switches retire the previous backend's retained publication and ACKs;
an HTTP response keeps its resource bytes charged until it releases them.

Only one preview owns DOM preparation and input for a session. Mirrors display
accepted documents with input disabled; explicit claim retires the old owner
before a new transaction enables input. Reconnection also requires a fresh
transaction. The DOM surface uses its own event channel and retires the Skia
listeners. Skia input awaits the final runtime SSE result rather than treating
the HTTP queue receipt as success.

`simulator-dom-browser-smoke.mjs` exercises real watch/reload, resize,
reconnection, ownership and cleanup. `simulator-mixed-renderer-browser-smoke.mjs`
exercises same-session DOM/Skia navigation and input across density changes.
Reports bind each result to its binary and sources. A manifest replacement
retires old DOM authority; retaining its image does not roll component side
effects back. DOM clarity follows browser DPR, so the Skia render-scale setting
is not presented as DOM supersampling. These development checks do not certify
other hosts, physical GPU behavior or performance budgets.
