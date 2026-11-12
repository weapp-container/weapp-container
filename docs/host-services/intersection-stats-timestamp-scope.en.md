<a id="intersection-清理与-stats-时间戳的实现范围"></a>
# Intersection Cleanup and Stats Timestamp Implementation Scope

[简体中文](intersection-stats-timestamp-scope.md) · **English**


The fixed baseline is WeChat 3.17.3 and `miniprogram-api-typings@5.2.3`: 1265 APIs × seven platforms = 8855 cells. This batch adds real Session Intersection private subscriptions and synchronous cleanup, together with the real file timestamp snapshot shared by statSync/fstatSync.

<a id="intersection-的私有订阅生命周期"></a>
## Private Subscription Lifecycle of Intersection

Session uses a private Page/Component incarnation, observer/subscription ID, and complete desired-state revision from the shared facade. Before the guest executes, both engines save the capture/dispatch transport and expose the effect queue, compatibility table, and globally named functions; these no longer have subscription or callback privileges. Native first removes revoked items based on a complete snapshot, then admits new items; owner token, page token, and real scope are validated during admission and notification.

`disconnect()` synchronously returns void, first triggering an irreversible local undo callback, then having the subsequent native boundary clean up the registry; repeated calls still return void. Callback privileges cannot be restored for queued, same-batch subsequent notifications, capability undo, component unloading, page incarnation replacement, and session termination. Effective subscription states are only committed after private delivery succeeds; subsequent public diagnostics failures do not replay previously published results. Rejections for illegal selector/root are consumed by retained transport; transport failure rejections retain retry debt, and post-repair effects are irrelevant and can continue. Intersection and MediaQuery have two independent cleanup families that execute separately before propagating errors, to avoid one family's admission failure from preventing the other from completing. Margin Proxy re-entry cannot bypass the nativeMode single relative root constraint.

Here we only count the zero-parameter cleanup member `object:IntersectionObserver.disconnect` as available on six native platforms, adding 6 units, acceptance remains pendingAcceptance. The public native SDK default Session allows entry only for Skia/SkylineCompat, and cleans up its own without requiring OS provider. The Web aggregation unit continues partial: the Software/ExternalFrame/CanvasKit Skia path shares cleanup, while the formal WebView/DOM path still explicitly disables observers, lacking a real DOM observer adapter. The complete selector, geometry/transform ancestor clipping, parameters, payload, reuse, and version semantics for constructor, observe, relativeTo, and relativeToViewport continue partial; factory and manifest capability remain partial.

<a id="stats-的真实时间戳快照"></a>
## True timestamp snapshot of Stats

statSync and fstatSync respectively obtain the actual path Metadata, actual open File Metadata, then proceed to the same fallible StatsSnapshot. Size, mode, and the two timestamps and predicates come from the same Metadata; if any required time accessor fails, the entire producer fails, avoiding returning a forged successful 0.

Fixed types define lastAccessedTime/lastModifiedTime as POSIX st_atime/st_mtime Number. Conversion uses i128 for signed integer seconds; epoch−0.25 seconds maps to −1, epoch−1.25 seconds maps to −2. Regular values retain serde i64/u64 JSON integer representation; bounded SystemTime seconds beyond these representations are converted to finite f64; JavaScript uniformly receives regular Number; no safe-integer rejection or BigInt is introduced. Snapshots do not change due to file time modifications, path replacement, fd close, or owner retirement.

Two independent timestamp fields added on six native platforms with 12 available; this fixes the implementation of producer and return fields, not a correction for missing predicate counts. The publicly available native managed_files_root synchronous installation chain is explicitly bound; full path/recursive/encoding/quota of producer, missing asynchronous producer, mode/size, and Web persistence remain with original gaps and cannot be inferred from field upgrades. Non-Unix mode still retains original synthesized values, not leveraging timestamp fixes for upgrades. Harmony verifies execution of the native Rust managed-files delegate, does not claim ArkTS or device execution.

<a id="已验证与交付边界"></a>
## Verified and Delivered Boundary

Two candidates are executed independently in no-local checkout and independently in Cargo target. Intersection natively runs 90 successful executions, 82 distinct tests; new 8 tests and 15 explicit geometry traversals with real QJS/V8. Original three fixture assertions fail, zero test filter and runner path failures are retained, and product implementation is unchanged due to fixture fixes. Stats natively runs 25 successful executions, 24 distinct tests, plus Node 94; real FileTimes, independent Unix stat values, actual QJS/V8 Number/snapshots, Harmony Rust delegation, and adjacent fd lifecycle are passed; no implementation patches or failures occur. Original candidate and final test identity supplements are retained respectively.

After merging the selected workspace, independently execute production bootstrap for Intersection 38 items, owner 52 items, and combined format validation. Native evidence covers only the native macOS software/headless runtime; no execution for Windows/other OS, browsers, devices, public SDK consumers, WeChat oracle, or merchant acceptance. The generic SystemTime/POSIX source code paths for Windows do not equate to Windows execution evidence.

This batch of precise ledger increments are 18 partial→available: Intersection cleanup 6, Stats timestamp fields 12. Current available 1430 (16.15%) / partial 983 / requiresHostService 86 / missing 6356, accepted 0, N/A 87, still 5654 short of target 7084. The stage goal has not yet been completed, parent full volume acceptance goal remains paused and uncompleted. Final combination freeze and Web artifacts must be tied back by subsequent precise submission acknowledgments; candidates validation re-marking for post-submission execution is not included in this segment.
