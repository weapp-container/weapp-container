# Shared Web preview ownership

`web_preview.rs::PreviewState` is the single lease ledger in `web.rs::Shared`.
It owns primary client, checked epoch, connected clients, the bounded request
queue and bounded retired-lease receipts. `DomState` retains DOM request,
DOM surface generation, request authority epoch, pending/accepted documents,
resources and input state. A renderer change does not create another owner
ledger or reuse an old epoch.

The public wire types and `/api/preview` routes keep their existing shapes.
`connect`, `claim`, `heartbeat` and `release` still enter the same owner queue.
The owner plans a transfer, retires runtime authority without the Web mutex,
then commits with `runtime_retired: true`. Client, queue, lease and retirement
bounds remain 16 clients, 32 queued requests, 15 seconds and 32 receipts.
A late release acknowledges its original retired lease without removing a
new connection with the same client id. The last `u64` epoch cannot wrap.

`WebSurfaceHandle::capture_preview_owner` produces a non-serializable
`PreviewOwnerFence` bound to the actual `Shared` allocation, client and epoch.
`validate_preview_owner` checks that allocation again and revalidates the
live owner/expiry. A same-valued fence cannot authorize a different surface;
a cloned handle to the same allocation remains valid. No Web lock crosses
runtime work through these APIs.

This common proof does not require a DOM request or carry a DOM request
revision. It proves only lease ownership, not renderer, session, frame,
geometry or presentation. Callers must layer those authorities separately.
DOM presentation and `view.*` operations continue to require a current DOM
request and its authority epoch; a valid common proof cannot bypass them.
A new DOM request may reject a queued DOM operation without changing the
common owner lease.

This extraction preserves the current DOM-only HTTP admission policy.
Configured browser capability alone still does not activate an unloaded DOM
profile. Inactive profiles allow only recognized cleanup/expiry as before.
Raster, CanvasKit and desktop policies are not newly enabled. Strict Raster
CLI/SSE connection tokens, frame tickets, binary headers and RAF receipts
remain a later integration; no GPU, browser or device execution is established
by this source change.

Existing DOM/HTTP/lease tests keep their names. New source tests cover common
proofs before a DOM request exists, DOM request supersession independently of
lease ownership, same-valued surfaces, handle clones, mirror denial, claim,
reconnect, live expiry, late cleanup and epoch exhaustion. Compilation,
formatting and execution must be reported by the final integrated-source run.

## DOM owner retirement

DOM publication consumers move replaced `CachedView` and desired-request
`Value` owners into `DomRetirement`. The receipt is declared before acquiring
the `Shared` guard and destroyed after releasing it, including error/unwind
paths. `clear`, renderer-profile/session changes, lease transfer, request
replacement, pending publication, accepted replacement, abort and runtime
reconciliation preserve their original authority decisions. Lease transfer
continues to keep the desired request while retiring its presentation authority.
Generation exhaustion rejects before moving any existing DOM owner.

Retirement does not create a second resource budget. Existing
`retained_response_bytes` Weak entries continue to charge each resource's
actual `Vec` capacity for as long as its Arc is alive in the receipt, a response,
or another cached document. A later admission reclaims only dead Weak entries.
The candidate resource map also outlives the guard on publication errors.
Each candidate resource Arc enters that same Weak ledger immediately after
allocation, before a later resolver or validation can fail. Subsequent admission
counts only the next allocation, since earlier candidate bytes are already
charged. Actual reserved capacity is rechecked after inserting the resource in
the map, so rejection also keeps its owner alive until unlocked destruction.
Production-consumer source tests observe actual replaced owners at destruction,
check mutex availability, retain the original capacity charge until the resource
is destroyed, and check rejection preserves old owners and input state.
A real two-resource publication failing on the second resolver or digest also
observes the first candidate's actual destruction: the mutex is available, its
Weak capacity charge is still live, and the charge is reclaimed after drop.

This change deliberately does not claim a wholly lock-free preparation path.
`publish_view_submission` still invokes its resource resolver, verifies bytes,
and prepares resources while holding `Shared`; `retain_browser_pending` still
invokes its runtime predicate under that guard. Profile/request entry still
calls `Shared::retire_raster_publication` under the guard, which can destroy
legacy raster owners. A subsequent prepared-publication change must capture
actual allocation/request/owner/profile authority, perform external work after
unlock, then revalidate that same authority before moves-only publication.
Simply unlocking and installing an unbound candidate is not a valid replacement.
These remaining boundaries are separate from DOM retirement evidence.
