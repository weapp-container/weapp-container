<a id="浏览器开发态-http-控制客户端"></a>
# Browser Dev HTTP Control Client

[简体中文](browser-control-http.md) · **English**


`crates/container-simulator/src/browser-dev-http-control.mjs` provides
`BrowserDevHttpControl`, for trusted native owner access to existing
`BrowserDevOwnerManager`. It does not acquire preview lease, nor starts Worker. `WebSurface` now provides
explicit opt-in control queue and independent opt-in development UI; default resource-only service continues to provide only allowed static GET. Ordinary Browser watch CLI and experimental example share the same explicit runner; fixed Worker producer and bundle list remain independent.

Initialization must explicitly provide a root `baseUrl`, `runId`, `clientId`, and `secret`. Browser-side requires the current page to be same-origin; POST disallows redirection, and verifies the final response URL. Three command endpoints are:

- `/__weapp/control/invoke`
- `/__weapp/control/replay`
- `/__weapp/control/acknowledge`

`/__weapp/control/observe` accepts the same authentication and fixed `{"version":"1.0"}`, reads only the original owner's typed snapshot, does not consume command ledger, serial, final, or ACK; the response is still subject to HTTP capacity and deadline limits.

Each request sends `X-Weapp-Run-Id`, `X-Weapp-Client-Id`, `X-Weapp-Dev-Secret`.
The server uses the native owner's fixed identity before the first acceptance, Origin/Host, and secret for authentication; these
client headers do not grant permissions. The underlying client is not responsible for owner, preview election, or Worker closure association;
`serve_browser_dev` and the regular CLI reuse the same runner for explicit Browser profile, bridging these boundaries; see [Development Loop](browser-dev-loop.en.md).

<a id="显式服务端接入"></a>
## Explicit Server-side Access

First create `WebSurface::bind_resource_only`, then call `enable_control(ControlHttpAuth)` before the first accept. The same instance can only be enabled once; no support for selecting run, client, or new ledger; regular old simulator surfaces cannot be enabled. The auth must match the actual plain-HTTP listening address; TLS/proxy configurations explicitly reject. For IPv4/IPv6, default HTTP port 80 and HTTPS port 443 use trusted authorities as specified by browsers, omitting default ports; incoming Host/Origin headers must still match exactly. Browser-unsupported IPv6 zones, and IPv4-mapped IPv6 with spelling mismatch to Rust Host, are explicitly rejected during initialization; regular IPv6 (e.g. `::1`) is supported.

Original owner lane advances as `poll → resolve_control_requests → resolve_resource_requests → poll → wait`.
The resolver borrows the original request together with fixed auth, responsible for making **original** `ControlLedger` calls to admit/lookup/ACK;
this layer of service does not perform coordinator mutation and does not forge successful Worker close. ACK must directly invoke `acknowledge_final`, and cannot first lookup to add one, as that would prevent its own compression by the final borrower.

Control the namespace to intercept before old Content-Length, OPTIONS, and wildcard CORS. Classification occurs only after the first line is collected, avoiding misclassification and destruction of legitimate runtime GETs for fragmented `/__weapp/run`. POSTs must use exact HTTP/1.1, these fixed paths, unique framing/auth headers, and standardized Content-Length; identity and declaration length are immediately verified upon full header receipt, without waiting for unauthorized body. Reject Transfer-Encoding, Trailer, Expect, Upgrade, query, encoded paths, and received trailing bytes; error responses do not reflect secrets or local paths. Control responses with same-origin policy, nosniff, no-store, and no wildcard CORS.

header limit 16 KiB, invoke/replay body limit 64 KiB, ACK body limit 129 KiB;
Internal original request still limited to 64 KiB. Each opt-in incoming socket is pre-allocated with a bounded wire buffer, and conservatively reserves four times the maximum wire space, covering the original buffer, ACK decoding scratch, and strings; the `control_request_reserved_bytes` in state is a conservative accounting and not RSS. The owner queue, half-requests, and responses share the original 64 connection limit; after resolver returns, the original request copy is not retained. Normal, recovery, and cleanup share a limited socket capacity at the transport layer; this layer does not guarantee infinite cleanup progress when saturated.

`WebControlResponse::Final` moves the original ledger's `Arc<Vec<u8>>` into the actual response body, HTTP only counts the small header, does not copy or re-encode the final. ACK reply encoder itself is limited to 4 KiB. accept to owner lookup,
writes with shared original 5-second deadline; continues using 256 KiB quantum / 2 ms round-robin writer. The actual body borrower is released only when the surface is completed, disconnected, timed out, or dropped. HTTP send completion does not imply client acceptance of the result.

`stop_admission()` only stops new accept; existing requests, replies, and cleanup can still proceed according to the original deadline.
`drain_status().is_drained()` merely indicates that admission has stopped and all sockets have been released; it does not prove ACK delivery, worker closure, or supervisor cleanup completion. The listener port is released only after the surface is dropped; when intentionally abandoning delivery, only the associated surface can be dropped, followed by a retry exit on the original supervisor.

<a id="原始结果与-ack"></a>
## Original Result and ACK

`invoke(request, {signal})` is allowed only once and cannot be invoked again even if the network fails or the actual working capacity is insufficient.
`replay(request, {signal})` only queries the same request that has been accepted. The client saves the first serialized UTF-8 bytes, and subsequent requests must be identical; no automatic reordering, eviction, or resending of mutations occurs.

Request upper limit 64 KiB, final upper limit 256 KiB, ACK reply upper limit 4 KiB. Streamed read verifies actual length, Content-Length, UTF-8, response type, and result identity. SHA-256 applied to raw final bytes; parsed result deeply frozen, with WeakMap associating original request and hash. Serialized JSON cannot replace the original hash.

manager calls `acknowledge(request, originalParsedFinal, {signal})` only after fully adopting and retaining the result. Copies cannot authorize ACK; at most one actual ACK per request, reusing previously validated receipts on success, and allowing explicit retries on failure. The ACK body is:

```json
{"version":"1.0","originalRequest":"<首次请求的原字符串>","finalSha256":"<原始 final SHA-256>"}
```

The server response contains only the same `version`, `requestId`, `finalSha256`, and `outcome: "compacted" | "already-compacted"`. Since the originalRequest is JSON-escaped again, the ACK body can exceed 64 KiB; the server must set a bounded upper limit internally. The original request itself remains under a 64 KiB limit.
The ACK itself does not retire the server tombstone and does not prove that the Worker has closed or that the current frame has been presented.

<a id="可选前缀退休协议-10"></a>
## Optional Prefix Retirement Protocol 1.0

`BrowserDevOwner::enable_control_retirement()` is explicitly enabled before the first command, and repeated enabling or already having a high-water mark will be rejected. Trusted UI uses `enable_browser_dev_app_with_retirement` to emit
`bootstrap.retirementVersion: "1.0"`, and the client passes the same value during construction; only then can the manager use
`retryControlRetirements({maxOperations})`. The old entry and clients without negotiation remain disabled.

`retire(originalRequests)` selects the earliest acknowledged prefix within the same lane, up to 64 entries;
rejects release if there are existing actual fetch, hash, reader, abort relay, or unsettled manager transactions.
It does not consume new command serial and does not repeat invoke. New endpoint: `POST /__weapp/control/retire`
Uses original authentication and strict framing, with body and response limited to 4096 bytes:

```json
{"version":"1.0","lane":"normal","previousThrough":"0","throughSerial":"7","prefixSha256":"<SHA-256>"}
```

Summary concatenates the following transcript byte by byte using UTF-8, retaining a newline at the end. Actual records are recorded in increasing order of serial;
no new lines are inserted for missing numbers, and the end must be a present, compacted record.

```text
weapp-control-retirement-v1\n
{runId}\n
{clientId}\n
{normal|cleanup}\n
{previousThrough}\n
{throughSerial}\n
{requestId}:{originalFinalSha256}\n
...
```

The server deletes records only after fully preflighting the prefix. The reply contains exactly `version,runId,clientId,lane,
previousThrough,throughSerial,prefixSha256,retiredCount,outcome`, with outcome set to `retired`. The normal and cleanup lanes each retain an independent cursor, permanent admission high-water mark, and latest exact request/reply; each of the four wire projections is bounded to 4 KiB. An identical retry after a lost receipt returns the original receipt without a second mutation. Conflicting cursors or digests, old transactions, and prefixes not yet ACKed are rejected.

The client retains one pending transaction per lane, and after failure, it can only retry the original batch. On success, the promise includes cleanup of the original request; byte and capacity are released only after cleanup is complete; the caller retains the original promise/receipt and cannot resubmit a request with a released ID. Out-of-order, holes below high-water, and `u64` overflow are permanently rejected and not reset.
The manager can only delete locally reserved entries that have been proven never transmitted and whose transactions have ended; it cannot forge remote ACKs.

`status.highWater`、`status.retirements.{normal,cleanup}.throughSerial` and manager's
`controlRetirements` distinguish retained, in-transit, and failed. Pending or failed retirements do not authorize Worker cleanup;
Stop must continue the original shutdown flow, transport drain still awaits actual retirement work registered.
`manager.drainControlWork()` additionally waits for completion of ACK/retirement registration at the manager level, accounting for failures and notification; it does not initiate retries or new requests. HTTP drain may occur before manager work startup or result acceptance, and cannot serve alone as a barrier to reading ACK pending status.

<a id="容量与关闭"></a>
## Capacity and Closure

Original entry Map relies on the validated command to fix normal/cleanup identity; a maximum final retention fee is pre-collected upon first acceptance. Actual work uses a separate budget, and normal or ACK cleanup reservations are not allowed.

| Task | Default in-transit count | Default logical byte budget | Retained entry upper limit |
| --- | --- | --- | --- |
| normal invoke | 8 | 16 MiB | 512 |
| cleanup invoke | 2 | 4 MiB | 128 |
| exact replay/recovery | 2 | 4 MiB | does not create entry |
| ACK | 8 | 4 MiB | does not create entry |
| prefix retirement | 2 | 256 KiB | one pending transaction and the most recent receipt per lane |

Byte budget includes the reserved cost of the original entry and temporary reservations for actual work; the entry has already received final, so normal final received from recovery does not consume cleanup/recovery reserved space. The actual effective entry capacity may be limited by byte budget. The sum of all budgets is the logical accounting upper limit, not a guaranteed browser RSS. Cleanup/recovery explicitly fails or remains pending if it itself exhausts or the adapter does not respond, and no infinite cleanup progress is guaranteed. When connecting to an owner, coordination of bounded reserved capacity with manager, transport, and ledger is also required; the entry remains with a finite lifetime until retirement is negotiated.

`status` displays various in-transit quantities, reserved, and temporary fees. There is no background queue, retry timer, preemption, or silent eviction at the lower level. Each actual request has an AbortController, a parent signal relay, and a body reader; reentrant adapter calls, including access to the signal property, are performed after registration work is done.

`close()`/`dispose()` returns the same barrier: first rejects new work, cancels associated requests, then waits for actual
fetch, hash, reader cancellation, and relay cleanup. Ignoring cancellation of adapters allows the close to continue waiting;
cleanup failure returns `closed:false`, without faking success. The caller must first close the actual Worker manager,
then wait for transport; transport closure is not proof of owner close or server-side body borrower exhaustion.

<a id="串行-owner-库入口"></a>
## Serial owner library entry point

`browser_dev_owner::BrowserDevOwner` moves the original `DevSupervisor`, coordinator, and `ControlLedger` into a serial owner. It requires a prepared standalone fixed runtime, a real managed stage policy, and client/preview provided by a trusted startup context; on initialization failure, it returns the same supervisor along with the error, and the caller continues retrying the owner's cleanup.

`stage_latest` and `poll_stages` execute source barrier, static stage, and completion validation on the original supervisor,
retaining at most two stage metadata. `enable_control` is only enabled on explicitly resource-only surface;
`resolve_controls` synchronously connects to the original ledger, `resolve_resource` borrows bytes from the original stage/runtime.
source events are passed to the caller's log/diagnostic sink and are not recursively initiated in control commands.

Successfully `startOwner` registers exact owner/ site/ actual stage protection before returning final, Starting
And occupies protection even with unconstructed intent. Disconnection, source expiration, or stop does not release it. Default
`enable_control` continues to use `NoActualBrowser`, rejecting all successful close reports.

A trusted local launcher may explicitly call `enable_browser_reported_control` before the first acceptance, binding the lifecycle identities of the same owner's run, client, preview, and current surface objects to the browser-reported closure policy. This identity does not inherit listeners or resources; the surface retains the identity after movement, and the policy is not inherited upon re-binding at the same port after destruction. Failure to enable control does not activate the policy; HTTP requests cannot enable it. The launcher must deliver the same credential to a single actual manager, preserving the original inert entry's identity and the actual construction/closure barrier. The ownerId of each entry must be unique upon first creation, and replaying the same request maintains the original value; it must not allow two managers to share a deterministic sequence number and independently adopt the same start final.

The strategy comparison server stores the original binding, client, site index, and backend at startOwner;
upon existing runtimeReady, it also requires full tuple consistency. The original coordinator still validates the complete CloseTicket;
only upon successful state transition of this original ticket can the protection be lifted and the corresponding actual stage be retired. This is an associated acceptance of a trusted manager's report, not proof from the server side observing Worker termination.
The actual bootstrap and browser loop are handled independently by the `serve_browser_dev` example and verified, see [Development Loop](browser-dev-loop.en.md); this interface does not expose ordinary watch CLI, election, or takeover endpoints.

`try_shutdown` is only retried on the original owner; no protection for stage retirement or original body borrower
Emptying and supervisor cleanup wait separately. `false`/error is not completion. The caller should first complete actual
Worker's precise shutdown, then stop HTTP admission; prematurely stopping will block subsequent cleanup/ACK.
Listener drop and socket drain still do not prove the Worker is closed.

<a id="关闭回执中的实际身份"></a>
## Actual Identity in Closing Receipts

`outcome: "closed"`'s `receipt` is versioned `BrowserWorkerCloseReceipt`:
`version: "1.0"`, `closed`, `workerClosed`, `ownedMountRemoved` must be true,
and explicitly contain optional `owner`, `rpcIdentity`, and `workerFinal`. `owner` uses the existing
Worker tuple (epoch, session, pack index hash, backend); `rpcIdentity` comes from the RPC epoch/session captured by the real owner. Non-empty tuple must be consistent with RPC, original offered site, and known runtime tuple. Server DTO validates shape, but still does not consider the report as closure authorization.

A session that has been constructed but whose load has not yet been called may return three empty fields; a session with an RPC created but not yet passed pack validation may return an empty `owner` and a non-empty `rpcIdentity`/`workerFinal`; when pack validation has passed but load is not yet ready, the actual tuple must be retained. All these states belong to the real closure of a constructed session and cannot be rewritten as `never-constructed`. The latter allows only the original inert entry proof to demonstrate that construction was never attempted.

Real `WorkerWebSession.close()` continues to wait for the original load, adapter, resources, bridge, RPC, and mount cleanup. The manager only sends finishClose after waiting for that barrier, verifying identity, and retaining a receipt; on failure, it retains the original registration and remains in an uncertain state. HTTP content remains browser-reported; by default `NoActualBrowser` remains rejected, and only the explicitly started strategies can accept association success. Without recorded runtimeReady, actual RPC-only receipts can complete cleanup; runtimeReady cannot be fabricated for this purpose. Interface code and unit tests themselves do not prove that bootstrap, real Worker closure, or browser watch have passed.

`owner.control_cleanup_ready()` is the read-only delivery cleanup gate of the original ledger: must have no `unresolved_final`, and all retained entries in both lanes must be tombstones of `FinalCompacted` that are ACKed; empty ledger or retired compacted entries do not block. Queued, Executing, Prepared, unACKed Final, and ExecutionUncertain all block. NeverExecuted may prove no execution has occurred, but still lacks an accepted final, so cannot be considered delivery cleanup complete. Queries do not consume ACKs, compression results, or remove tombstones. Shutdown must simultaneously satisfy the success of the original owner's `try_shutdown`, passage of this gate, and actual emptying of the original HTTP queue; a fixed grace period or socket disconnection cannot substitute for these conditions.

<a id="可信开发-ui-服务接缝"></a>
## Trusted Development UI Service Seam

After the owner enables control, the owner can call
`surface.enable_browser_dev_app(&owner.preview())` before the first accept on the same resource-only surface. Only loopback is allowed, and each surface can successfully enable control only once; connections are denied if control is not enabled, if a connection has already been received, if acceptance has stopped, or if it is a regular old simulator surface.
This API provides only UI bytes, does not execute Workers, does not elect preview, and does not alter the default shutdown policy.

Root `GET /` inert `application/json` contains
`{bootstrap:{version,baseUrl,runId,clientId,preview},secret}`; run, client, secret, origin
Retrieved only from original `ControlHttpAuth`, preview is passed in by trusted caller and verified against run/version/lease.
Escape `<>&` before embedding, do not write to URL, Debug, or error messages. The HTTP client retains credentials after page configuration node is removed, and page state does not output secret.

Fixed scripts are provided only through `browser-dev-app.mjs`, `browser-dev-owner-manager.mjs`, `browser-dev-http-control.mjs`, `worker-session-client.mjs`, `browser-dev-entry.mjs`, and `dev.css` under `/__weapp/dev/`.
They originate from compile-time source code and do not exist on any disk path or arbitrary file fallback. Paths for root and assets match the original paths exactly, and share a strict framing parser with immutable resource GET; upon UI enablement, all such GET requests must match the original auth host exactly, and query, encoded/traversed path, non-GET, trailing body/pipeline are not granted to the UI.

HTML and fixed assets are pre-encoded and atomically added to the original HTTP memory budget; actual writing reuses the original accepted-at deadline, connection limits, and writer. Responses use no-store, nosniff, same-origin CORP, no-referrer, and `frame-ancestors 'none'`, without adding wildcard CORS. Testing this service seam does not imply that the browser bootstrap, Worker, or presenter gateways have passed; CLI still requires separate wiring.

<a id="执行证据范围"></a>
## Scope of Execution Evidence

`scripts/test-browser-dev-http-control.mjs` Uses controlled fetch/stream to test bytes, capacity,
receipts, cancellation, and synchronous re-entry. It does not run Rust, HTTP service, Worker, browser, presenter, or GPU.
Actual TCP and dedicated Rust ledger tests are explicitly executed with evidence bound to source code and execution scope;
seven hosts, performance, and official oracle gatekeeping continue to be managed independently.

```bash
NODE_BIN="$(command -v node)" cargo test -p container-simulator \
  --test browser_control_http --all-features --locked -j4 -- \
  --ignored --exact real_tcp_transport_uses_original_control_ledger_and_arc_body_barrier \
  --test-threads=1 --nocapture
```

The stage result and actual commands are available in [client evidence](../archived-evidence.en.md).
