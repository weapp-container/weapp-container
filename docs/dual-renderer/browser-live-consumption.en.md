<a id="live-document-21-显式消费"></a>
# Live Document 2.1 Explicit Consumption

[简体中文](browser-live-consumption.md) · **English**


This is an independent, explicitly enabled protocol extension. By default, `DomLiveSessionClient` continues to use version 2.0. Standard simulator CLI and Worker product entry points retain their original protocols. Version 2.1 does not provide native editing lease, nor does it grant access to Chinese IME, hardware GPU, seven hosts, or performance certification.

<a id="协商与请求身份"></a>
## Negotiation and Identity Request

The client sends `liveVersion: '2.1'`, followed by a `view.live.enable` request with a payload of `{"version":"2.1"}`. The outer bridge maintains `protocolVersion: "1.0"`.
Runtime generates a 128-bit lane using system entropy; if entropy is unavailable, a clear error is reported. On successful contract, the following contract field is added:

```json
{
  "version": "2.1",
  "requiresOwnerReplacementWhenFull": false,
  "transactionRetention": {
    "version": "1.0",
    "laneId": "runtime-issued-opaque-lane",
    "firstSequence": "1",
    "explicitConsumption": true
  }
}
```

Other contract fields are retained, including `nativeEditing:false`. The original envelope and the full outer final are preserved separately. For identical requests, only the original result is replayed; lane reissuance or profile switching is not permitted. Negotiation metadata is capped at 8 KiB, and negotiation final is capped at 512 KiB.

Prepare, permit, presented, and abort payloads use `version:"2.1"` and include an additional field: `transaction:{laneId,sequence}`.
Sequence is a strictly formatted decimal u64 string starting from 1. requestId must be exactly `live:<laneId>:<sequence>`. New admissions are permitted only for the highest accepted sequence number plus one; capacity rejections do not advance the sequence. Replays are compared against the full original envelope. Consumed sequences are permanently rejected and cannot be re-executed through ID change, operation modification, payload alteration, or renumbering.

Ordinary business results remain stored in the AppService outer turn and are purged upon effect clearance. Correlated responses now include `consumptionReceipt`: the SHA-256 hash of the original complete batch. The client is not required to recalculate this. It is a pure native-layer opaque final identity and not an application-level credential. Only a Complete final carries consumable receipts. On failure to seal, Indeterminate is retained, receipts are removed, and irreversible effects are preserved. The original fixed capacity and replay behavior from 2.0 remain unchanged.

<a id="纯元数据消费"></a>
## Pure Metadata Consumption

`view.live.consume` uses a separate requestId and does not consume a business sequence:

```json
{
  "version": "2.1",
  "inputLifetimeRevision": "7",
  "laneId": "runtime-issued-opaque-lane",
  "through": "12",
  "receipts": [
    {"sequence":"10","token":"sealed-final-receipt"},
    {"sequence":"11","token":"sealed-final-receipt"},
    {"sequence":"12","token":"sealed-final-receipt"}
  ]
}
```


Runtime processes this message during any storage repair, engine turn, or JS pre-processing. Metadata undergoes type decoding and cloning, preceded by an 8 KiB bound depth and node validation. Up to 32 receipts per batch, with the entire new prefix required to be contiguous, Complete, and fully matching. Entire batches are rejected for Pending, Indeterminate, missing, or erroneous receipts—no partial records are released. Business capacity remains at 32 items / 8 MiB. Consumption itself does not enter the final cache, nor does it trigger lower-layer ACK, lifecycle, effect clearance, or resource authorization.

On success, the final is fixed as `{"ok":true,"consumedThrough":"12"}`. For repeated requests, only the current actual epoch, lane, and format are verified—no re-execution is performed. The original success shape is preserved even if the old deadline or cancellation token has expired. New prefixes still respect deadlines and cancellation. Explicitly expired and unactivated requests are rejected. Real input epoch changes may release old tables, but the highest sequence number and retired watermark for the same lane are not reset; clients cannot trigger such changes using future epochs.

<a id="客户端结算与清理"></a>
## Client Settlement and Cleanup

```js
const client = new DomLiveSessionClient({ ...options, liveVersion: '2.1' })
await client.negotiate()
await client.prepareAndPresent({ render, surfaceGeneration: '1' })
await client.consumeCompleted()
```


`consumeCompleted()` processes only those prefixes that have been definitively terminated, resources have been truly cleared, and both original and restored transport have completed settlement. After local timeout of the original request, even if a restored request achieves an exact final, it must wait for the actual settlement of the original promise. Without a complete final, only the original envelope may be restored—no re-entry beyond the sequence, ID change, or deletion of records due to timeout is permitted. The onBatch callback is invoked exactly once per entry; synchronous callback errors do not cause re-delivery of effects.

If a consume reply is lost, the original immutable metadata envelope and all covering records are retained, and new business transactions are suspended. A retry of the same pure metadata request is initiated via `recoverConsumption()`. Local records and bytes are only released after successful confirmation. Limited budgets are maintained for record retention, business/metadata exchange jobs, bytes, and diagnostic history. Diagnostics preserve only bounded code/message snapshots and do not retain any error reference graphs.
Close waiting for un-settled transports; requests that cannot settle are throttled and cannot falsely report success.

`Session::browser_live_transaction_retention()` is a read-only protocol ledger: record count, wire bytes, highest admission, and consumption watermark. This does not equate to process RSS and does not grant presentation or input privileges.

<a id="验证入口"></a>
## Verification Entry

```sh
cargo test -p container-runtime --features quickjs-native,v8-native --locked --test browser_live_consumption
node --test scripts/dom-live-session-client.test.mjs
node scripts/dom-live-runtime-browser-smoke.mjs --pack <text-controls-pack> --driver <dom-protocol> --out <new-dir> --live-version 2.1
```


Browser smoke uses real portable pack, native QuickJS/V8, and Chromium. Host-level passive observation is preserved in the original trace and is stripped only when the consume final is delivered to the client. The runtime's consume batch itself returns only a correlated response. These tests report against official oracles, real IME, GPU hardware, and other host gateways separately.
