<a id="tcpudp-对象监听移除的实现范围"></a>
# Implementation Scope of TCP/UDP Object Listener Removal

[简体中文](object-notification-cleanup-scope.md) · **English**


Product commit: `617862ab39b98bcc379c1a5c5f4fc9c1deafed45`. The fixed measurement scope is WeChat base library 3.17.3, miniprogram-api-typings@5.2.3, and 1265 APIs × seven platforms = 8855 cells. This batch changes only the 63 cells for the following nine off methods from Missing to Available:

- TCPSocket：offBindWifi、offClose、offConnect、offError、offMessage。
- UDPSocket：offClose、offError、offListening、offMessage。

The complete matrix also has 8792 complete cell objects unchanged. Available1777 (20.07%), Partial1308, RequiresHostService86, Missing5684; accepted0, platformNotApplicable87, still 5307 short of 7084. The byte counts for acceptance, coverage, responsibility, restrictions, parameter contracts, and ledger remain unchanged; stage objectives have still not been achieved. on, factory, TCP.close, UDP.close, and ad objects have no new credits.

<a id="单一回调所有者与真实取消"></a>
## Single Callback Owner and Real Cancellation

Nine actual on callback migration into existing private finite owner, separated by factory object, API, event, and subscription ID. Original function duplicate registration deduplication; off selects original function deletion, omits or undefined clears current object/event, repeated removal idempotent, synchronously returns void. Saved alias binds to original creator, changing this does not alter object reference. off has its own access control, does not depend on on/off provider, does not trigger additional close/destroy or factory cancellation requests.

Private authority first synchronously revokes, then the session cancels the native subscription's actual creator call; only after successfully completing the cleanup is an ACK with the retained prefix issued. Late-arriving events, subscription success/failure, and queue race conditions involving going off then on cannot resurrect old identity. Global registration rejects non-empty objectId; object registration must bind to a real, live native receiver type. Session, account epoch, API, object, event, and u64 sequence checks all occur before callback payload decoding.

<a id="对象生命周期和结算故障"></a>
## Object Lifecycle and Settlement Failure

TCP.close only terminates the connection and retains the socket object; UDP.close destroys the object upon success, otherwise retains it. A pending UDP close still allows the final Close event. off itself does not alter these lifecycles.

Factory failure, UDP successful destruction, and native terminal resource cleanup retire the private owner via the typed ingress retained by two engines prior to public Promise settlement. Retirement synchronization clears callback, closes, and deletes bridge object records. Public resolver, Promise.then, event queue, or facade are replaced by the application and no retired callbacks are retained. New private state and object records use prototypeless storage to avoid inheritance of setter capturing retirement privileges.

General finish_host_call collects the first cleanup error, proceeds to cancel the remaining real creator, then attempts outer-layer settlement and returns the error. This change involves shared asynchronous resource boundaries, thus this batch simultaneously executes the complete runtime/workspace and feature gates.

<a id="实际验证与首轮失败"></a>
## Actual Verification and First-Failure Attempt

Root actual passes through Node146/146 (where new files 40 items), related regression 198/198, count/matrix/IO1275/1275; the two production tag combinations of Node do not represent native engine execution. The three integrated files of real QuickJS/V8 each have original 7, new 11, and regular 9 test functions, with engine enabled in each loop. Overlapping commands are not counted as separate test totals.

Format, workspace all-targets locked check, all features with strict Clippy passed; no native feature compiled successfully and retained 36 warnings. runtime full-feature library 758 passed/0 failed/2 ignored; complete four-thread workspace 135 result blocks, 3067 passed/0 failed/10 ignored. The above commands overlap; not aggregated into a unique test count.

Produce WASM with explicit selection of installed rustup cargo/RUSTC/RUSTDOC, LLVM C toolchain, and wasm,quickjs-native, without using Homebrew Rust lacking the corresponding target. It is a compile-time check and does not involve this batch's Web release build, archive, installation artifacts, or browser execution.

First round Node144/146, Rust E0282 failures fully preserved. Node original use case polluted Promise.then after hook attachment, but settled via public raw resolver, failing initially in the fixture's own scheduler; later changed to pollute before hook attachment, and only restore scheduling via raw settlement, with actual Session simultaneously overwriting poisonResolve/poisonThen × factory failure/UDP destruction quadruple combination. Rust later explicitly specified Vec<String> type. Only new tests were modified; eight production sources and two inventory files remain in quarantine as candidates, independently verified and passed in subsequent rounds.

Inventory author's initial 699/702 failure, corrected to 1247/1247 and static source review retained. Root's 1275 actual rechecks include matrix/IO, cannot substitute inventory-only execution for API/native runtime.

<a id="来源产物与验收边界"></a>
## Source, Products, and Acceptance Boundary

The product only modifies 14 clear paths; all 1778 final non-document source codes and two matrices are byte-by-byte bound to the product Git blob, while the rest of the source code remains unchanged. Seven gitlinks, 913 historical files, and the default checkout of local main are unchanged. 52 additional SDK inputs are separately bound to current bytes and precise gitlinks; this batch does not modify SDK main, generate native SDK archives, or perform production releases. The package retains 59 source code authorship records, 348 inventory records, independent reviews, root failure/success and complete original command logs; historical parent packages are recorded according to committed parent records, and all raw historical files are included in this package.

Available credit belongs only to local listener removal and actual subscription cancellation. Complete event producer, fixed version payload/sequence/plugin behavior, seven-end installed public SDK/physical devices/WeChat oracle acceptance has not been proven by these tests. Ads six items off still require independent Page ownership and RewardedVideoAd singleton/multiton design.

This batch did not create or borrow browsers, Workers, or preview servers. All root test processes ended before packaging; no pages were retained. Historical affine browser failures maintain the original conclusion.

Complete evidence is available at [this package](../archived-evidence.en.md). The Performance private owner will continue to work independently; all six list queries remain Partial, and no credit will be granted until the route/render/resource/package producer is completed.
