<a id="live-document-v2显式实验协议"></a>
# Live Document v2: Explicit Experiment Protocol

[简体中文](browser-live-document-v2.md) · **English**


This path provides a stable Document, receiver identity, and presentation transaction for subsequent native editing lease.
It explicitly negotiates `nativeEditing:false`, preparing to freeze input via native `inert` during the period until final ACK,
without committing to focus, undo stack, or Chinese IME cross-update continuity. Regular simulators and Workers still use v1.

<a id="数据与事务"></a>
## Data and Transactions

Only a new browser presentation owner can initially send `view.live.enable` with payload
`{"version":"2.0"}`. Return contract declarations for document permit, live geometry finalization,
full final result replay, limited budget retention, and hard input revision. Existing v1 owners cannot migrate the protocol.
The outer `BridgeEnvelope.protocolVersion` remains `1.0`; `2.0` is the version of this standalone presentation contract.

1. `view.live.prepare`: Sends version, `inputLifetimeRevision` issued by runtime, decimal-string `surfaceGeneration`, and the original render request. The result includes the fully evaluated document, viewport, complete `PresentationKey`, a required and nullable `baseKey`, document token, and runtime identity for each occurrence. Evaluation uses the actual AppService and View engine.
2. `view.live.permit`: Sends the exact identity above, **without geometry**. The runtime issues a 5-second document permit for the saved candidate; repeated requests do not extend the deadline.
3. The browser prepares a typed patch, applying it to the same live Document only after obtaining a permit; retains the rollback journal and predecessor resources. Waits for actual image decode, fonts.ready, RAF, then measures full geometry.
4. `view.live.presented`: Sends the full permit and geometry v1 shape. The runtime validates the complete occurrence, key, viewport, epoch, and geometry before any presentation; then atomically accepts the document and geometry, executes ready effects, and returns the full outer-turn final.
5. `view.live.abort`: Sends exact key, document token, and hard revision; can only revoke candidates that have not been accepted. Previous frames can be retained, and previous input authorizations will not be revived. v1 prepare/permit/ACK/abort cannot operate on v2 owners.

After an irreversible publication, even if the ready timeout or final retention failure occurs, the result still carries `committed:true` and key.
The client must first accept this publication fact, keep the input closed, and report an error; it cannot rollback the accepted DOM.

<a id="接收者与资源所有权"></a>
## Recipient and Resource Ownership

QuickJS/V8 retains a private capture function before application code execution, uses a private WeakMap to identify real Page/component objects, without invoking user getter, toJSON, or application-overridden prototype methods. Object unmounting or destruction first marks them as retired, then executes user hooks. The runtime synthesizes a monotonic binding incarnation by combining these tokens with occurrence, component/slot ownership, tag, key, type/password. Ordinary data or value changes do not alter identity; removal, reconstruction, or A→B→A cannot recover earlier identities. Failure to acquire identity will invalidate the candidate.

`DomLiveSurface` holds its own created root/style, borrows Document, iframe, and mount.
Normal patch can reuse the actual node with the same identity; plan pre-check does not modify live tree. Decoder, RAF, and predecessor resources are released at the actual last usage point. dispose does not remove borrowed nodes or unrelated peer nodes.
Acceptance of the document retains the document's private receiver snapshot; touch contact shares the original snapshot.
v2's `view.events` and contact cancellation use the native retained dispatcher, performs full pre-check of receiver, then, before each handler lookup, after getter, and before actual invocation, verifies Page/component incarnation.
Scope resolution uses private own descriptor; application overriding `hasOwnProperty` does not alter event ownership.
Return value serialization and after microtask checkpoint of this task, then checks instance; upon detection of retirement, revokes hard input privileges of the old view, returns `ERR_CANCELLED`, preserves effects from prior callbacks and setData.
Normal setData does not replace the real receiver; microtask checkpoint is not inserted between listeners.

This validation only connects to explicit v2 owner, public v1 dispatch maintains original boundaries. It does not issue native edit lease, nor does it defer edit queue, trusted source-edit acknowledgment, or focus/IME continuity during updates.

<a id="精确-final-与容量"></a>
## Exact Final and Capacity

prepare/permit/presented/abort must each occupy an independent owner turn; any mixed bridge batch containing a live operation is entirely rejected before entering JS. reserve is performed between storage sync and JS, and is sealed only after the outer turn completes and failure effects are handled. Retransmission is allowed only if the requestId is the same and the complete envelope content is identical within the same epoch; modifications to payload, deadline, trace, etc., will also be rejected. pending or unsaveable final entries leave a tombstone and cannot be re-executed. When a client loses an ACK, it only re-sends the original envelope.

Currently, each hard input epoch retains at most 32 transaction requests, 8 MiB requests, and final byte; per request
256 KiB, reserving 512 KiB for final. Soft eviction of old results is not performed; when capacity is exhausted, ownership must be explicitly transferred.
It is not yet a production-grade policy for infinite watch loops. After the hard input lifecycle retirement, old requests return
`ERR_CANCELLED` and cannot be resumed across epoch; AppService failure requires replacement of the entire session.

<a id="运行验证入口"></a>
## Runtime Verification Entry Point

```bash
cargo build --locked -p container-host-common --example dom-protocol \
  --features container-runtime/quickjs-native,container-runtime/v8-native
pnpm host:webview:live-smoke --pack /absolute/path/to/text-controls-pack \
  --driver /absolute/path/to/target/debug/examples/dom-protocol --out /new/evidence/directory
```

This entry uses a background Chromium and a page, sequentially verifying a real QuickJS/V8 portable pack.
It does not replace the simulator service. Default readiness comes from a real browser; transmission loss and readiness failure
are explicitly injected faults, not official tool or hardware evidence. The fixture must retain the actual focus callback's setData, and cannot rely on removing the callback to eliminate feedback. Fixtures without images cannot prove image resource chaining.

Subsequent work still needs to be completed: editing lease, delayed event dispatch with actual receiver token validation, bounded consumption watermark,
Worker/remote product wiring, Chinese IME and focus continuity, and seven hosts and performance throttling.
