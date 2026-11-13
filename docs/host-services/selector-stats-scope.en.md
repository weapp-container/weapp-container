<a id="selector-私有调用链与-stats-接收边界"></a>
# Selector Private Call Chain and Stats Reception Boundary

[简体中文](selector-stats-scope.md) · **English**


The fixed baseline is WeChat base library 3.17.3, `miniprogram-api-typings@5.2.3`, and 1265 APIs × seven platforms = 8855 cells. Implementation status, source tests, installed artifacts, and real SDK acceptance are recorded separately. Limited tests do not upgrade the overall status of SelectorQuery, NodesRef, or file producers in this batch.

<a id="selector-的请求与生命周期"></a>
## Selector's Requests and Lifecycle

Two engines share `selector-query.js`. Requests, callbacks, actual Page/Component incarnations, and scope at selection time are stored in private state; the Session reads and completes requests via native-preserved capture/dispatch functions. Public diagnostic queues, object aliasing, and compatibility functions no longer hold authority over this call chain. Old queries without an actual owner cannot borrow their identity when a Page appears later; only previously Created, unmeasured manually embedded extensions are retained.

Each NodesRef retains its scope at the time of selection; subsequent builder.in() calls do not redirect old references; the portable NodesRef.in() extension simultaneously updates the reference. The current Page's rollback provides only lifecycle authority and does not fabricate a sync callback context; callbacks enter actual sync or explicit in(receiver) owner, and timers without specified context retain their existing behavior. Execution, each callback, and failure settlement revalidate the original owner, scope, current page, and presentation mode. Component replacement, hiding, unmounting, cancellation, and original deadline continue to block old results.

Private async completion executes bounded Promise checkpoint at the Session boundary; the lifecycle-retained dispatcher itself still does not run application jobs. After receiving one native delivery ACK, remove the routing ticket; the guest consumes pending state before scheduling the callback. A newly generated immediate query triggers the next effect drain, avoiding premature assertion of queue inactivity. The dual-engine return requires the final setData from three nested immediate queries to appear directly in the original dispatch; the negative control with sole deletion of the continuation condition fails accurately, and the original source code is subsequently restored byte by byte. This mechanism does not declare retryable transmission: execution or environment failures will lock the Session, with no persistent completion replay protocol.

<a id="基本几何及保留范围"></a>
## Basic Geometry and Retention Range

Basic boundingClientRect/scrollOffset projection shares public id, typed dataset, result slot order, and viewport space identity. Nodes without a public id return an empty string; internal occurrence id cannot serve as a public result id. Viewport does not inherit the render-root's id or dataset.

Native content dimensions use the renderer's actual content range used for scroll clamping; Web reads content dimensions and offsets from the iframe's real element and `document.scrollingElement`. viewportExtent appears only when a new request is needed, old requests retain their original form. Native border-box, overflow, ink, and full geometry still have gaps; no equivalent WeChat layout is declared based on this.

exec Continue to retain the existing Promise extension. Lock the declaration of NodesRef, yet define no return selection; official implementation evidence already saved is insufficient to support constructing terminal NodesRef cursor. This batch does not fabricate this object.

SelectorQuery/NodesRef is still partial: complete selector syntax (including `>>>`), fields/computedStyle/properties, real handle of node/context/ref, complete geometry and fixed version lifecycle/return value range are not yet closed. Tests explicitly reject currently unsupported deep combinators and do not treat ordinary descendant as if it had semantic meaning.

<a id="stats-方法与-producer-分开记账"></a>
## Stats methods and producer-separated accounting

Shared decoder only applies position conversion of internal markers in the documentation return locations of stat/fstat/statSync/fstatSync: top-level Stats, async result.stats, FileStats[].stats. The method captures two boolean values of the actual native metadata; subsequent modifications to the returned object do not alter existing snapshots. Missing, inherited, or non-boolean flags are rejected, and business JSON and additional fields retain the data.

Six native host statSync/fstatSync functions have already returned callable isFile()/isDirectory() in previous batches. This batch actually fixes the Harmony existing asynchronous stat embedded Stats still exposing boolean value reception defect, and completes API-specific decoding. The two receiver methods with no parameters, adjusting 12 units, are corrections for previously overlooked implementation gaps and cannot be described as adding 12 new platform APIs; Web is outside this scope. They return a snapshot of obtained metadata; closing the fd, path replacement, and owner retirement do not cause local predicates to read other files, and continued access to retired providers is disallowed.

True built-in recursive stat and async fstat are still missing. Test adapters using real disk metadata cover these wire shapes, proving only receiver/decoder, not indicating that the SDK has the corresponding producer installed. Gaps in FileSystemManager's path, recursion, encoding, quota, fd, and other parameters remain in the corresponding producer code.

Stats.mode at non-Unix still synthesizes permission, time field maps unavailable or pre-epoch values to 0; these members remain partial. size shows no specific numerical differences, but is outside the scope of this batch uplift. The implementation status of 12 units does not represent six-end builds, installations, or acceptance.

<a id="真实浏览器的有限证据"></a>
## Limited Evidence from Real Browsers

Isolate headless Chromium 149 using the current actual DomViewPresenter. Viewport content 900×1500→900×1800, window scroll 30/80, scroll-view 514×414→514×664, offset 45/60 all match the browser's original sampling. Old requests omit new fields, stale/retired requests are rejected, iframe count is 0 after dispose; context, browser, page, and loopback services are all closed.

This is not a public SDK, WeChat 3.17.3 oracle, device, or merchant execution. The first test placed a boolean into legacy attrs that only allowed strings, and the input was strictly rejected; the original failure and cleanup logs are retained. The failure logs from source code and native tests across all rounds are also retained, and the final freeze result is deemed valid based on evidence from the corresponding version.
