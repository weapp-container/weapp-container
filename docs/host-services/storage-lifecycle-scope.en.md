<a id="storage-事务与应用生命周期通知的实现范围"></a>
# Scope of Implementation for Storage Transactions and Application Lifecycle Notifications

[简体中文](storage-lifecycle-scope.md) · **English**


This article describes the submission boundary of shared storage, as well as the implementation and limitations of app foreground/background switching and page destruction notifications. Source code count is based on WeChat Foundation Library 3.17.3, `miniprogram-api-typings@5.2.3` with a fixed 1265 APIs × seven-end statistics.
Source code count and actual platform acceptance are separately recorded; platform conclusions must be tied to precise source code commits and verifiable execution evidence.

<a id="源码清点变化"></a>
## Source code change tracking

| API | Android/iOS/Harmony/Web/macOS/Windows/Linux | Unit Change |
| --- | --- | ---: |
| `wx.onAppShow`、`wx.offAppShow`、`wx.onAppHide`、`wx.offAppHide` | partial → available | 28 |
| `wx.onBeforePageUnload`、`wx.offBeforePageUnload`、`wx.onAfterPageUnload`、`wx.offAfterPageUnload` | missing → available | 28 |
| `wx.batchSetStorage`、`wx.batchSetStorageSync` | missing → partial | 14 |

These eight lifecycle APIs share the same real-time runtime implementation, with new available 56. Four foreground/background notifications are existing partial completions, while four page destruction notifications are newly implemented. This batch does not introduce new storage available.
The current candidate values for matrix generation are available **1393**, partial **995**, requiresHostService **86**, missing **6381**, totaling still 8855; accepted **0**, platformNotApplicable **87**.
available accounts for 15.73%, still 5691 short of 7084. This source code count does not equate to full batch freeze or real SDK acceptance.

Previously, the overestimation correction for `wx.setStorage`, `wx.getStorage`, and `wx.setStorageSync` across seven platforms and 21 units is retained. The ordinary quota has been implemented, and it is no longer accurate to claim "no quota at all"; the remaining AES, full JSON parameter domain, and byte algorithm boundaries cannot be removed from the missing conditions merely because quota has been added.

Fixed type file SHA-256 is
`25e9e6fdab1b4282ee5231d8f8de7a31a177d2edc690ec834e0da479cc166245`.
Its async set/get definition includes AES128 paired with `encrypt`; batch set uses `kvList`, synchronous
batch set receives an array and has no `encrypt` parameter. The fixed version only has four batch read/write APIs, without
`batchRemoveStorage`. In page destruction notifications, the before result includes real `page`, `path`,
`routeEventId`, while after contains only `path`, `routeEventId`; all four off allow omitting listener
to remove all. No capabilities not present in the fixed signature can be added based on other versions or example comments.

<a id="存储从本地成功到宿主提交"></a>
## Storage successfully sent from local to host submission

Original implementation first modifies JS storage, then schedules a public patch; the engine ACKs before applying the patch to the Session.
Rust applies patches one by one, and subsequent errors might leave committed prefixes, while the JS replay record has already been released. The old clone will return the original object upon JSON encoding failure, and subsequent modifications, serialization, or host refresh might alter values that have already succeeded.

Now QuickJS/V8 installs the same `container-core/src/storage.js`. Writing first uses JSON intrinsic encoding and validation captured at startup, then performs a pre-check of the full transaction, and finally publishes it. Batch setters do not recursively call multiple individual setters that have already succeeded. Cyclic, BigInt, encoding errors, quota violations, or queue rejections will not publish the outer transaction prefix; successfully completed nested writes in getters/toJSON maintain their causal order and are not revoked by outer transaction failures. Reads return independent snapshots, with undefined/null/absent values continued to be stored separately.

Private ledger saves the byte-encoded committed values, undefined markers, and consecutive transaction sequence numbers. Public storage map, `storage.patch.batch`, and forged sidecar are available only for compatibility or diagnostic purposes and do not grant write permissions.
Native captures the raw private transaction prefix; Session first decodes and verifies it, then submits it via core typed transaction. Storage phase precedes the unrelated, potentially failing public effect to avoid a malformed setData discarding previously successful writes.
After core submission, the sequence number and stamp are recorded before ACKing the ledger. On ACK failure retry, previously committed transactions are not reapplied; suffixes generated during serialization are retained.

Add storage-only reconciliation that directly retrieves pending transactions from the retained native ledger without converting public effects or executing application microtasks. Even if toJSON of public effects throws an error or exceeds decoding depth, it first submits successful guest writes in order before the host writes, full MemoryStorage replacement, or baseline refresh. It does not recover by repeatedly draining complete effects to avoid re-triggering side-effecting or persistently failing public serialization. Interrupted realms still obey sticky execution faults and cannot be resumed by reconciliation for guest execution.

`MemoryStorage` handles legacy individual methods and new transactions along the same precheck/submit path; on precheck failure, it does not modify values, marks, counts, revision, stamp, or runtime events. The value `revision()` remains compatible with `Session::storage_revision()`; freshness now uses a non-persistent instance stamp. When the entire storage is replaced by an instance with the same revision value, the engine still flushes, and the SDK still queues to save a new snapshot. The SDK records the stamp only after the writer accepts the snapshot.

Normal persistence format retains `values + undefinedKeys`, old values-only JSON continues to be read. usage
And stamp are not written to disk. Default restore preserves old overflow data and recomputes counts, without truncation, and does not modify them in this batch to strict mode; overflow state allows only non-increasing writes, remove/clear operations are recoverable, explicit strict restore requires further validation. native SDK's merge of full snapshot writer, atomic replace, flush/close barrier, and account namespace boundaries retain their original responsibilities.

<a id="存储限制"></a>
## Storage Limitations

Normal quota uses a logical algorithm defined by the container: a standardized JSON UTF8 payload, with each value capped at 1,048,576 bytes; each entry is charged based on the total byte count of `[key,payload]`, with a total cap of 10,485,760 bytes; undefined values are stored with a four-byte `null` charge and an independent type marker. Numbers are charged according to ECMAScript NumberToString; `currentSize` is rounded up to KiB, and `limitSize` is 10240. This is not a byte algorithm verified by WeChat's reference environment, and does not equal the size of persisted JSON files.

Rust JSON decoding enables `float_roundtrip`, preserving the exact IEEE754 bit values of JavaScript Number after JSON normalization. The original approximate parsing would map some finite decimals to adjacent values, altering read results and potentially causing native re-feeing with an extra byte, leading to erroneous rejection of a 1 MiB payload already accepted by JavaScript; this fix simultaneously covers both numeric and quota threshold values. This fix ensures consistency between the two ends of this container, without upgrading the logical algorithm to the WeChat-tested algorithm.

key Follows the native Unicode White_Space blank rules, retains the original key bytes without automatic trimming.
JS no longer uses ECMAScript trim differently from Rust rules: pure U+0085 keys are rejected before release,
U+FEFF keys can read old snapshots and continue writing. This avoids failure due to inconsistent blank rules—first succeeding in JS and then failing at core submission when the blank rules don't align; this is an inter-layer compatibility rule, not evidence of a newly acquired WeChat boundary behavior.

New writes have deeper depth 128, node count 1,000,000, up to 100,000 per batch, up to 4096 transactions without ACK, with explicit limit of 64 MiB per transaction. Legacy native snapshot uses iterative neutral replication and does not directly apply the new write depth limit to existing data; this does not guarantee bypassing the entire JSON bridge, disk decoding, or other budgets of the engine. A JS lone UTF16 surrogate cannot be losslessly passed through current Rust JSON Value; it is now explicitly rejected prior to release, while valid surrogate pairs are permitted. This rejection cannot be termed complete JavaScript string support.

`wx.setStorage`、`wx.getStorage` with `encrypt:true` explicitly fails, no plaintext written in pseudo-encryption;
AES128, set/get flag markers, encryption 0.7 MB/7.1 MB quota, key lifecycle and versioned ciphertext envelope
not yet implemented, both remain partial. `wx.setStorageSync` and the two batch setters also fail due to the above completeness
JSON/UTF16 and limited parameter ranges, byte algorithm confirmation gaps remain partial, no promotion based on registration or quota constants.

`wx.batchGetStorage`、`wx.batchGetStorageSync` are still missing. Especially the result field of asynchronous batchGet
The behavior for missing keys still needs reference implementation locking and cannot be inferred from GeneralCallbackResult. Web KV cold start
recovery/saving is not covered by this batch; OPFS file service and whole-Session Worker do not provide this proof. The remaining seven items
already have storage API using the original scope, and this batch will not downgrade any three previously confirmed overestimates into new groups.

<a id="生命周期的接收者与收尾"></a>
## Receivers and Cleanup in the Lifecycle

Foreground and background listener and App hook are separated. on performs deduplication registration, off removes by function identity, no parameters passed. Removes all, returns undefined. Dispatches snapshot of listeners for reading; modifications to current callbacks during iteration do not alter the current traversal. Normal listeners continue subsequent callbacks after exception reporting. Session uses the native dispatcher preserved via bootstrap to send notifications, publicly compatible aliases cannot replace the dispatcher. App hooks still dispatch the same transition's options on ordinary exceptions, and repeated show/hide states are not resent.

Before the route is destroyed, find the actual Page by private receiver incarnation; the hook's
receiver also retrieves it from the retained live-page to avoid before callback modifying the public page map, ID, or route. After sending onUnload to a forged object. The user Page hook itself still belongs to the app object; here, the retained is the actual instance identity, not freezing app methods. After is dispatched only when the matched instance has retired and routeEventId/path is consistent, and no longer includes page. After synchronizing the current page projection, after cannot see the destroyed page.

The same route event ID is used for multi-page back/reLaunch operations; cached tabs are only hidden and not mistakenly destroyed.
Direct page.push/page.replace first validates path, query, and data, then triggers old page hooks or modifies the stack.
Invalid requests such as blank path, non-object query/data do not terminate the current instance and do not trigger before/after notifications;
It is not possible to first destroy the old page, then rely on new page stack failure to recover.
Page.onUnload still completes observer, EventChannel, component, and receiver cleanup, retains original hook errors to avoid overwriting original errors. The after callback can trigger a new route, and the old instance will not be notified repeatedly.
Terminating app unload clears listeners and pending departure and route states even if a hook throws an error.
Ordinary route unloading notifications and app termination resource release are handled separately, and termination cleanup is not disguised as a new route event.

Native timeout/interruption still terminates the current execution, cannot retry partially dispatched callbacks, and cannot assume a chance to execute
guest finally to clean up. `wx.onError`/`wx.offError` has complete unhandled-error and offError
without-parameter clearance, real page-not-found dispatch for `wx.onPageNotFound`/`wx.offPageNotFound`, and binding to UI
render transaction completion via `wx.nextTick` still have gaps, remain partial.

V8's native installer, notification dispatching, and private receiver capture reads the exception when TryCatch holds an exception;
records the real termination state, retains the `Interrupted` type and logs it to the adapter, and subsequent pure Rust control also rejects continuation.
The pending interrupt requests from idle isolates themselves are not indicative of an executed fault; regression testing separately validates the public interrupt entry and actual native termination triggered within the execution loop, without adding guest execution probes to strategy methods.

<a id="验证与未验收边界"></a>
## Verification and Unaccepted Boundary

Behavioral regression is located respectively in core `storage.rs`, shared by dual engines `fixtures/storage-engine.rs`, runtime `tests/storage_transactions.rs`, `tests/lifecycle_notifications.rs`, and SDK `storage_stamp_tests`/existing persistence tests. Coverage includes rejection without prefix, nested codec writes, private authority, ACK/suffix, quota, depth, host ordering after public conversion failure, revision replacement, exact Number round-trip and 1 MiB threshold, Unicode key, invalid direct navigation, real Page identity, termination retirement, listener/hook exceptions and re-entry. Node source inventory tests verify that counting stops after evidence chain disconnection and cannot substitute these real engine behavior tests.

Compilation during development, depth, and budget failure retention are preserved, and early failure records are not overridden. The final test count, ignored tests, source code hash, and exact commit are recorded by the current freeze evidence; the document scope does not pre-announce full gate acceptance, and Node VM, native engine, Session fixture, Skia CPU raster are not collectively termed device tests.

No seven-end public SDK, actual browser, physical device, merchant transaction, or new native archive installation acceptance has been reported in this batch.
The previous `2428f6c` Web direct/Worker release CanvasKit archive and new directory byte installation are bound to the old source code, excluding the modifications in this batch and cannot serve as execution for the public SDK in this batch. The unchanged seven SDK gitlink does not imply that the old runtime archive has been updated; if a new archive is produced, it must be bound to a new product submission, fixed sourceSha256, version/coordinate, license, archive/manifest hash, and must be installed and verified in the new directory according to a fixed manifest hash. Builds, archiving, installation, actual startup, public SDK, device, and transaction are separately logged; unexecuted layers are explicitly marked as not-run, and accepted remains 0.

The sourceDirty state in historical records retains its original value and does not change due to document consolidation claiming that the corresponding source has been cleaned or fully reproducible.
This document is not a valid credential for SDK release; the release status should be determined by the versioned manifest and the corresponding acceptance records.
The previous consent browser proposed report cannot be considered a formal accepted result of the current implementation.
