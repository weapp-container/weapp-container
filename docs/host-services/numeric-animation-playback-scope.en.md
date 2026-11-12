<a id="数值-animation-播放实现范围"></a>
# Range of Numerical Animation Playback Implementation

[简体中文](numeric-animation-playback-scope.md) · **English**


This batch connects the `animation` property to the trusted clock, identity, and presentation transaction of the Session. Previously, the shared `animation.js` could only record and export motion; now, limited numeric motions can consume the same timeline samples in both native rendering and Web DOM environments. This document records the implementation strategy and limited validation scope, and cannot be used to infer the complete behavior of WeChat Foundation Library 3.17.3.

Fixed denominator remains at 1265 API × seven ends, totaling 8855 frames. Current baseline is Available 1504, Partial 1070, Requires host service 86, Missing 6195, Accepted 0. No frames are promoted in this batch; the 84 frames corresponding to 12 numeric methods remain at Partial, while other Animation methods, factories, `step`, and `export` retain their original levels.

<a id="时间线与数值范围"></a>
## Timeline and Value Ranges

Decoder accepts a structure of `actions → animates/type/args + option` exported by a shared producer.
Supports `opacity`, `rotate`, `rotateZ`, `scale`, `scaleX`, `scaleY`, `skew`, `skewX`,
`skewY`, `translate`, `translateX`, `translateY`. Numbers must be finite, opacity ranges from
`[0, 1]`. 3D transformations, length strings, width/height, and positioning for layout animations have not yet entered this playback chain; the entire operation is rejected if the queue contains unsupported actions or fields, and success cannot be claimed by simply skipping the action.

Actions in the same step transition simultaneously; actions in different steps execute in sequence. Supports `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `step-start`, `step-end`, including delay and zero duration; Bezier curves reverse the progress by x. The last write operation on each axis overrides the previous value in the same group. `rotate`/`rotateZ` share the same rotation axis; axes not written retain the endpoints from the previous group. These repeated actions and alias strategies belong to the container's current convention and currently lack a fixed WeChat version-specific oracle verification.

Transform endpoints retain translation, rotation, scale, and skew values and compose them as `T × R × Scale × Skew`. Each sample is calculated from the original endpoints without accumulating matrices between frames. Existing two-dimensional CSS matrices establish a baseline through QR decomposition: X scale is nonnegative and Y retains its sign. Reconstructible rank-one and zero matrices are supported. Numerically unstable matrices that cannot be reconstructed within the checked precision are explicitly rejected, as are skew values crossing poles and unreliable large angles. Valid endpoints may still overflow during intermediate sampling, so the entire batch must be sampled and validated before publication.

opacity reads the real parsed baseline; it cannot be assumed to be 1. Modifying only the opacity queue will not read or override unrelated transform; existing matrix3d thus does not interfere with standalone opacity animations. Newly touched transform must be able to acquire the actual 2D affine baseline. `transformOrigin` reuses the WXSS parsing path, retains the source string, and is parsed according to normal font, viewport, and border-box rules; supports parseable 2D origins, with initial/unset normalized, inheritance, delayed parse values, and non-zero z rejected. The origin switches discretely at the end of the group's delay, and subsequent groups retain the previous group's origin during the waiting period.

Each queue can hold up to 4096 step, 16384 operation, 4 MiB JSON payload, and 24 hours of cumulative duration;
origin string can be up to 4096 bytes. Session can retain up to 4096 bindings/running at once; aggregated binding payload and write identity are subject to an additional 8 MiB limit. These are explicit resource policies and do not represent the total memory ceiling of the JS engine.

<a id="绑定重播与-owner"></a>
## Binding, Replay and owner

View/IR records the source of private attributes, data dependencies, and source code occurrences during evaluation, while Session synchronously captures Page/Component incarnation and snapshot writes when reading data. The direct path, actual execution branch, dynamic member selection, and its control dependencies, `wx:for` collection index aliases, include, and template direct object aliases/shorthand/spread can carry sources; construction of scalar, conditional, or computed template mappings conservatively rejects sources. WXS, modules, and external executable dependencies currently do not provide sources and do not perform source collection by re-evaluating user expressions. Public attributes, exported objects, or bridge parameters cannot select owner, write stamp, or animation clock. Animation bindings whose sources cannot be restored must be explicitly rejected.

Accept the receipt path compared to the parsed data path and the written stamp. Normal re-rendering continues along the same accepted timeline;
A successful `setData` on the relevant path, even if the queue value is equal, can form a new playback. Path identity is forwarded to the component input from the true source, and the component's local write takes over the corresponding path until external property updates; parent-child, locally named variables, and different incarnations do not share playback identity. Slot reuse retains existing declaration ownership and caches the source snapshot; no new real slot is being introduced in this batch. Without a successful related write, changing the payload alone does not trigger a replay;
same-value stamp does not trigger ordinary observer/dirty mutation. An identity is reserved prior to data write, and the data transaction is committed upon success;
failure or loss of reserved or private receipt will block subsequent animations in this session, and cannot reconstruct the source using an untrusted public effect.

Replace animation first captures value samples from the old animation during the preparation phase as a new starting point; newly added properties read actual CSS baselines. The baseline restoration must cover exact occurrence and requested properties, with no omissions, duplicates, or multiple entries.
The old samples from the parent element first participate in normal stacking, then inherit baselines are computed for newly targeted child elements. An empty action queue freezes the captured styles; removing bindings removes the animation overlay layer.

Explicit native frame or template carrying explicit data replaces a template without real-time Page input proof. They truly get accepted and then retire old topology node identities and runtime, retaining private write ledger and Page paused states; subsequent nodes reappearing with the same origin code reestablish baseline. Failed candidates and late ACKs do not prematurely retire accepted bindings.

<a id="时钟呈现与生命周期"></a>
## Clock, Presentation, and Lifecycle

Animation time comes from the Session monotonic clock. Each host turn fixes a sampling moment, with nested calls reusing it;
guest timer timestamps, public configuration, and WASM exports cannot advance the clock. Test-controlled clock is visible only within `cfg(test)`.

When preparing a new animation, first generate a style with elapsed 0, and only anchor the start point after actual presentation is accepted. Asynchronous preparation, browser layout, and waiting for ACK do not consume playback duration; failed candidates cannot install timelines. Normal re-rendering of old animations retains the original anchor. When a page is hidden, pause its clock; upon restoration, continue from where it left off. Page, Component scope, Session retirement, and source invalidation all block old candidates and late ACKs.

Independent `sampleDemandRevision` only indicates a sample demand and cannot replace a template, document, presentation, or input identity.
This field is enabled after the first successful animation discovery acceptance, and the old path retains its original shape; failed discovery does not install a new lane.
Candidates carry frozen `{ demandRevision, sampleRevision }`, and a preparation cannot be changed at ACK time.
New demands are merged after the precise release of the old candidate and cannot be renamed after terminating the old sample. Sample sequences and demand sequences are each validated, without assuming any numerical size relationship between them. Demands are generated approximately every 16 ms and are supplemented with a precise end point; the actual presentation frequency still depends on the host poll and the presentation pump.

Native sampling reuses the originally accepted raw declaration scenario, re-executing normal styling, layout, image authorization, and Canvas
Declaration preparation, then atomically publishing a new renderer revision; no re-execution of View/WXS or ready hook.
Software raster submits upon actual acceptance; external frame and developer presentation path await corresponding ACK.
Input and component snapshots reuse the original template acceptance records and cannot concurrently adopt data prepared afterward. Redensity, scroll,
Canvas, and developer resize among existing redraws carry original sampling proofs only when exact input/previous version relationships hold.

Web consumes `animation` with precise baseline occurrence and typed binding during semantic preparation, and removes the original value from the browser's plan. Upstream evaluated seven classes of `wx:if/elif/else/for/for-item/for-index/key` are retained only as sources and are no longer projected as HTML attributes or evaluated; unknown `wx:*` continues to be rejected. Worker samples the unified three-argument contract `preparePaint(demand, accepted, context)`, using a private final ACK proof and client retained key/input/authority to validate the prior version. Input version may precede captured demand, but sampled replies must preserve the exact prior version of input. Animation bindings with null or empty string lacking metadata remain unsupported.

Web's first template candidate reads the real computed style in the hidden layout, applies frozen numeric styles, and then proceeds with normal geometric and presentation transactions. Subsequent samples retain the same accepted DOM and documentRevision, only incrementing presentationRevision; the browser is responsible for verifying targets, atomic style writes, and geometric feedback, but not for advancing time or interpolation. On application failure, the old style is restored via undo; if restoration fails, cleanup errors are retained and success is blocked; styles cannot be rolled back after ACK. Old topologies, epochs, inputs, and permits cannot authorize new samples. The scheduler only retries when a real template or sample is required, and failure levels cannot be forged by adding ACK fields to trigger refresh.

The first template and retained sample share an exact final cleanup rule. After issuing a presented request to runtime, local timeouts and cancellation cannot independently decide rollback; cleanup first uses an exact-key abort query on the final state. Runtime retains bounded presented final or terminated tombstones: presented replies contain either the original permit or consumed sample, proving only historical acceptance, with input always closed; only terminated allows local rollback, late presented cannot revive it. When transport or final state is unknown, retained applied styles, DOM, and resources are preserved, blocking both regular and legacy successors, and the process report is not considered complete cleanup. Reconnection allows requerying, and genuine native presenter retirement can authorize a new round of emptying; previously failed cleanup Promises retain their failure results. Verified ACK is first synchronized and stored locally in journal/key, then input guards, prior resource release and activation are invoked; if a guard throws an error, the already-accepted image is not revoked.

Retain the DOM sample to continue using the resource lease held by the DOM, without re-reading images, without switching documents, without installing resources;
It does not constitute a new BufferURL consumer. In the native retention scenario, when a new frame is generated, it still goes through normal image preparation, and a new Skia/cache read verifies current BufferURL permissions. After cancellation, the existing lease for already published immutable frames/DOMs retains their original last-use lifecycle, and this point cannot be expanded to authorize new consumers.

<a id="最终验证范围"></a>
## Final Verification Scope

v3 completed fmt, workspace all-targets check, all-features strict Clippy, runtime all-features
lib and four-thread workspace. runtime: 757 passed/0 failed/2 ignored; workspace:
132 result blocks, 2999 passed/0 failed/10 ignored. Commands overlap, cannot be summed as independent test counts.
v8 Rust input is identical to v3 byte-level; source code differences are listed separately in the evidence, with no claim that v8 reran the full Cargo.
The previous standard parallel View/native_query timeout failures remain unattributed; the four-thread pass does not rewrite historical failures, nor does it relax timeout or assert.

v8 Web Node 979/979, count/matrix/IO 539/539, actual matrix generation and --check passed. Regression includes
modern View VM preserving structural instructions after actual evaluation, precise animation metadata and error occurrence,
original properties not entering browser projection, CSS animation/transition denial, ACK cancellation and final state settlement.
Regression of the actual owner/RPC/bridge/scheduler/DOM adapter/client/presenter combination also covers preserved ACK
continuous sampling, and the race condition where show native observation occurs before local visible state update. Scheduling is paused during lifecycle control, and only resumes after both real final and local control fences are ready; old show cannot override updated hide, existing fences for metrics and surface recovery remain effective.

217 complete cell object updates, 31 animation seven-end implementation scope, source code references, and gap explanations,
the remaining 8638 objects unchanged.
8855 states, acceptance, coverage, and responsibility unchanged, CSV/contract/ledger byte counts unchanged. Current
Available 1504, Partial 1070, Requires host service 86, Missing 6195, Accepted 0,
N/A 87, still 5580 short of 7084, this batch Available increment 0.

Clean private build snapshot to `2a9889589eceee0d90e60f9944e5589e89de34de`, 494 compilation input summaries to
`040e2da5570e16d82fa16644c054920b860e36ff78d0cf01f4c67ac6fa9ee833`.
This commit only identifies private inputs, not a parent repository product commit. Actual QuickJS/WASM software renderer's
legacy/Worker release, tar.gz archive, fresh directory installation, and independent 2084-item input byte verification passed.
Reusing existing Cargo target, does not claim a fully reproducible new target or environment. Six existing tracked notices
entered the private commit prior to v8 build, independent of the 494 compilation inputs; v3 had a notice added after build and used
a subsequent license chain, with both original failure and supplemental scope preserved.

Chrome 156.0.8078.80 headless actual installation artifact execution via: direct 8 items, production Worker 6 items.
Scenarios cover CSS initial values, intermediate/endpoint values and hit geometry, DOM identity retention, value re-play, replacement,
old ACK rejection, node removal, and precise final state settlement after direct runtime acceptance but sample/template ACK
response cancellation. Worker hide/resume only proves limited input recovery for this fixture, not extended to browser full lifecycle oracle. Two lane use hand-written and re-computed synthetic fixture with no upstream build or public SDK acceptance. Strict pageerror/requestfailed are all 0, including during cleanup phase; page/context/browser/Worker/server all closed, port 9187 verified closed, no page retained.

v1 QuickJS prototype setter, v2 IR numeric key provenance, v3 animation property rejection, v4 wx:if
Property rejection and v5 Worker three-argument interface drift retained separately as failures. v5 direct 8-item passes retained via this lane, without rewriting overall failure. v6 intermediate pin count failure resulted in no browser build or run; Node source retention with race condition limits. v7 initial count's old interface token failure and subsequent 868/539 check separated in retention; browser passed direct 8 items and Worker 4 items after resume timeout, overall failed. v8 reused identical fixture, assertions, and timeout, re-froze, built, installed, and executed; subsequent passes did not override failure records. Full source code binding, logs, and failure/success relationships see [this batch of evidence](../archived-evidence.en.md).

Official documentation only supports default values, seven easing types, group parallel/group sequential execution, and export queue clearing, among limited descriptions.
Aliases and action ordering, value replay, unstep action export, interrupt replacement, hide/resume, and precise presentation
The starting point still lacks fixed 3.17.3 oracle. Source code pin, testing, and synthetic browser execution do not replace the publicly available SDK for seven endpoints,
device or merchant acceptance; all Animation remains Partial, Accepted is 0, 80% of targets continue active.
