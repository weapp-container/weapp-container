<a id="web-输入因果诊断-v1"></a>
# Web Input Causal Diagnostics v1

[简体中文](input-causal-diagnostics.md) · **English**


This interface records independent facts such as input, original View clone, GPU submission, canvas replacement, and runtime ACK, to prepare real 375×667, 2× measurements. No compositor frame flow, compositor presentation feedback, or physical screen evidence is available; all reports remain as `gate.status: "blocked"`, `inputToPresentP95Ms`, and scroll drop-frame rate remains as `null`. Protocol phase duration cannot be considered as input-to-screen duration.

<a id="显式启用"></a>
## Explicit Enablement

The Worker Skia owner and development manager accept optional `inputTiming: { version: "1.0" }`.
Default calls do not send sideband; prior Worker load, frame, and bridge receipts do not include this field.
DOM Worker explicit enablement returns a protocol error and cannot silently switch measurement mode.

The development manager must verify the full runtime-exported `INPUT_TIMING_CONTRACT` before constructing an alternate owner, preparing draw resources, and retiring the old owner. Missing or unknown declarations preserve the old owner as available.
Actual load must return the same negotiated result. Static declarations and load success do not prove GPU or presentation success.
Load failures after the old owner has been genuinely closed still respect the existing single-instance boundary and cannot roll back a destroyed JS heap.

`WorkerWebSession.inputTiming` returns an immutable report of the current owner; development app's `inputTimingReport({ ownerKey })` requires an exact owner key and returns identity, stale status, and report.
It does not expose session objects and does not grant input permissions. Invalid keys are explicitly rejected.

The native input helper carries only `{ version, sampleIds }` within the outermost host context; business bridge envelope, event, sequence, and batch boundaries remain unchanged.
A single native pointerup event generates a shared sample for touchend/tap; it cannot be double-counted as two physical inputs.

<a id="关联与时钟"></a>
## Association and Clocking

Each sample is bound to an immutable Worker owner/session, capture page, template revision, surface generation, input lifetime, and logical viewport.
The Worker reads only state before and after real native dispatch and records actual outer/inner request IDs and final outcomes; it does not treat HTTP receipt or execution start as applied.

Only successful inputs that actually modify the template revision, without crossing page/viewport/generation/lifetime, and where the original render's consumed-input proof consumes the same updated revision, are recorded as `exact-data-revision` candidates.
Only inputs occurring *before* the clone are marked as `ordered-only`.
Subsequent timer revisions, no-ops, missing state, page switches, or old frames cannot be elevated to strong association.
This candidate only establishes a data revision relationship and does not prove visible pixel-level changes.

The Worker freezes the clone receipt at the time of original render; `frame.current`, scale redraws, and recovery can only reuse the same consumed-input origin receipt.
They cannot attach the latest applied sequence number to an old clone.
When the original clone has no receipt, it is explicitly incomplete.

The Window uses its own monotonic clock to record input capture and receipt reception times for each phase; the Worker's time remains within its own `worker-monotonic` domain, while DOM `event.timeStamp` retains `dom-event-unmapped`.
The two domains are not subtracted, and wall-clock calibration is not performed.
Missing, negative, or backward clock values are recorded as faults, and candidate durations are not output.
Reports provide only `protocol-stages-only` within the same Window domain, without generating percentiles or conclusions.

The four subsequent facts are: original clone received, validated GPU submitted, irreversible visible canvas swap, and real runtime ACK received.
The "canvas swap" name refers to DOM operation completion, not compositor display.
Latency, failure, discard, duplication, unknown receipt, or owner retirement are all preserved as facts.

<a id="有界性与诊断隔离"></a>
## Boundedness and Diagnostics Isolation

Each owner may store at most 512 inputs, 64 frames, and 2048 events (up to 4096).
Each sample may link to at most 4 frame attempts, with each frame linking to up to 128 samples; the Worker may store up to 32 batches of applied facts, each batch containing up to 64 IDs.
Explicit drop and omission counts are tracked; no single `lastInputAt` covers concurrent inputs.
Physical target retains 4096-pixel side length and 16 MiB RGBA limits.
Only identity, revision, size, time, and result are preserved; event business payload, data, or resource content is strictly prohibited.

Diagnostic callbacks cannot modify input, dispatch, JS, scheduling, presentation, or closure barriers.
Synchronous exceptions are counted separately; asynchronous callbacks are not awaited, rejected for observation, and cannot consume real business errors.
Counts only describe diagnostic integrity.
Diagnostic overhead has not been measured and cannot be claimed as having no performance cost based on Node tests.

After enablement, the outermost `inputTiming` is optional and may be omitted.
Clients and Workers independently validate and reserve original business payloads; diagnostics do not consume business in-flight byte credits.
Actual final ownership upon cancellation remains preserved as per original business byte count.
Each diagnostic is limited to 256 KiB, 8192 nodes, and 16 layers, and is constrained by existing request limits, without expanding business message or queue thresholds.
At send time, the original message byte, node, and depth limits must still be met; if insufficient, only the diagnostic is omitted, not the business message or its result.

Diagnostic output and native business DTOs are kept separately; diagnostics are only attempted to be appended after successful business final validation.
If space permits, `{version:"1.0", omitted:"payload-budget"}` and similar fixed hints are returned; if the hint itself cannot fit, the field is not sent.
Missing entries in the Window's bounded ledger are recorded as `not-delivered`.
No remote-specific root cause inference. `omittedDiagnostics` and `diagnostic-omitted` events explicitly record the occurrence.
Diagnosis is incomplete; no causal candidates are generated for this frame. The receipt of the original clone is not overwritten due to transmission omission, and subsequent retained exports can still only use the original receipt.

<a id="remote-和旧-ui"></a>
## Remote and Legacy UI

Remote raster/DOM lacks native input → original-clone token, thus only retains independent input batches and their exact protocol completion records; reported as `association: "unavailable"`, without linkage to the next frame.
The development UI can invoke `globalThis.__weappInputTimingReport()` to retrieve limited historical data.

Legacy UI's `presentedAt`/`inputToPresentMs` have been removed. DOM uses `transactionCompletedAt`/`dom-protocol-completed`; GPU path displays `gpu-submit-and-runtime-ack`; CPU software path uses `drawCompletedAt`/`canvas-putImageData-return`.
The displayed transaction time cannot be upgraded to screen presentation time.
Retained `presentMs` is a compatibility field, indicating the main thread duration of the current transaction.

`simulator-presentation-smoke.mjs` software testing reads `drawCompletedAt`, with its old reports preserved in original bytes.
The historical CPU/RAF metrics from this script cannot verify the performance of Worker CanvasKit, GPU, compositor, or physical display.
New comprehensive performance thresholds must independently obtain causal pixels, frame-flow, and presentation endpoints, with separate original evidence preserved.

<a id="验证边界"></a>
## Verification Boundaries

Node contract coverage includes default compatibility, static/actual negotiated, real Worker RPC code-level request correlation, original/retained clone, timer/no-op/cross-generation isolation, boundaries, clocks, diagnostic error throws, Remote multi-input, and phase separation.
Among these, native host, DOM, GPU, and clock can use controlled double; this is not Cargo, WASM, real browser, hardware, or performance measurement.
Subsequent actual execution must be independently bound to source code, compiler, pack, environment, and original reports.
