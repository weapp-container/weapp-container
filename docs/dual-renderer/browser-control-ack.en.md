<a id="浏览器开发态控制-final-ack"></a>
# Browser Developer Control Final ACK

[简体中文](browser-control-ack.md) · **English**


Control operations, HTTP transmission, and client acceptance represent three distinct phases. The original `ControlLedger` reserves capacity upfront, executes the operation exactly once, and retains the original final bytes; after disconnection, only the result of the same request can be queried. HTTP writeouts, SSE notifications, timeouts, or new snapshot operations do not authorize compression of this result.

<a id="原账本入口"></a>
## Original Ledger Entry

`ControlLedger::acknowledge_final(authenticated_run_id, original_request_bytes, exact_raw_final_sha256)` rebinds the request within the original ledger. The caller does not need to reconstruct a `ControlIdentity` containing private serial information, nor does it need to update the identity table. The original request continues to match via its existing canonical contract; the final hash must be computed over the received raw response bytes and must not be derived from re-encoded JSON content.

| Original State | ACK Behavior |
|---------------|--------------|
| `Final`, correct hash, no pending response/replay borrower | Compressed to `FinalCompacted`, returns `compacted`. |
| `Final`, still has original Arc borrower | Returns `Capacity`, retains original bytes and fees, allows retry of the same ACK later. |
| Same compacted request and same hash | Returns `already-compacted`, supports retry after ACK response loss. |
| Invalid run/client, conflicting request, incorrect or non-compliant hash | Explicitly rejected; does not alter high-water mark or capacity. |
| queued, executing, prepared, or non-final tombstone | Rejected; cannot use ACK to cancel execution or clean up uncertain states. |
| retired/unseen, including unseen empty IDs below high-water mark | Returns `RetiredOrUnseen`; cannot verify that an old hash was accepted, and no re-enqueue occurs. |

This entry reuses the borrower and fee barrier from the original `compact_final`. It does not clone an Arc that would prevent itself from being compressed into a final. It does not automatically retire tombstones: the original tombstone continues to retain request fingerprint and final hash, and entry count remains bounded. The high-water mark only prevents re-execution of old IDs; it does not prove the content of a prior ACK after the fingerprint is deleted.

Authentication for the run/client must originate from the owner's selected manager context and cannot rely solely on self-reported HTTP request credentials. An ACK only proves that the client confirms retention of the final result—it does not prove that the Worker has shut down, that the current view is rendered, or that the site corresponds to the latest source code. These validations remain separate and require exact close, presented receipt, and fresh source barrier respectively.

<a id="manager-的可选采纳接口"></a>
## Manager's Optional Acceptance Interface

`BrowserDevOwnerManager` retains the existing `control.invoke/replay` and optionally accepts `control.acknowledge(request, originalParsedFinal)`. The manager first fully validates and applies the final, retains it in the original command record, then invokes ACK. The object passed to transport is the one returned by the manager—specifically, the parsed object—and can be linked via WeakMap to the hash of the received bytes; it is not a copy of the object made by the manager. Transport must still validate the original body, request, authenticating identity, and server-side ACK receipt—similarity of objects alone does not imply successful ACK.

Each command may retain at most one actual in-flight ACK; globally limited by `maxFinalAcknowledgementsInFlight`, defaulting to 8, maximum 64. An ACK failure does not trigger a retry, does not consume cleanup command serials, does not revoke previously accepted results, nor mark the owner as uncertain; failures remain in the original command and are retried explicitly by the caller, with no background timer or secondary command queue. Late-arriving final results of equal content are not resubmitted; conflicts remain sticky control protocol errors and do not confirm conflicting results.

`retryFinalAcknowledgements({maxOperations})` has bounded progression of retry work within the original command table, returning the count immediately without waiting for network. `status`, `recover()`, and `close()` respectively report `finalAcknowledgements` and `transportDrained`. Necessary Worker/owner shutdowns continue to complete according to the original barrier; `closed:true`, `workerClosed:true`, or `coordinatorStopped:true` do not equate to network clearance. When `transportDrained:false`, the caller must continue to retain or explicitly close the associated control transport—discarding un-settled requests is not permitted.

<a id="接线与验证边界"></a>
## Connection and Validation Boundaries

This entry does not expose HTTP control routing or browser watch CLI. Static resource entry points remain restricted to GET requests from the allowlist and cannot be used to send ACKs or activations. The manager's optional seam does not include HTTP transport; raw response association, server-side authentication, receipt delivery, and actual network teardown must be handled separately and validated independently.

An independent [HTTP client](browser-control-http.en.md) has been provided with raw byte association, limited request and close barriers, for subsequent owner integration. Existing static services will not expose control endpoints due to the presence of this module.

The state rules herein belong to the control receipt contract. Rust or controlled JS transport tests cannot substitute actual Worker, browser, rendering, GPU, seven-host, or performance gatekeeping.
