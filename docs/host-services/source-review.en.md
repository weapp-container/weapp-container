<a id="api-来源审定"></a>
# API Source Approval

[简体中文](source-review.md) · **English**


The source identity of the API manifest is saved in [Inspector](../../scripts/core-api-inventory.mjs). The complete file summary is uniformly saved by `reviewedSourceSha256`, and each capability check selects its own fixed source set; the control flow identity of JavaScript uses the canonical AST summary calculated by the fixed Acorn version. Source code changes must be reviewed, and the current summary cannot be automatically accepted when generating the matrix.

These identities only indicate that the specified source code has been reviewed. They do not prove full compiled behavior, full compatibility with official APIs, real-device execution, merchant transactions, or actual acceptance of each SDK. The status of the platform is still determined by the independent [Acceptance Ledger](./acceptance-ledger.json) and [Acceptance Contract](./acceptance-contracts.json).

<a id="2026-11-12-复核范围"></a>
## 2026-11-12 Review Scope

This time, we aim to compare the previously reviewed original content with the current content on a file-by-file basis based on the implementation in the open source code snapshot. Updated 20 full file identities, as well as AST identities that notify hub, installer, lifecycle, host bridge, and Promise rejection handling. No changes were made to the capability rating, acceptance deed, or acceptance ledger.

| Source | The Boundary of Change and Retention |
| --- | --- |
| `container-engine-quickjs/src/lib.rs`, `container-engine-v8/src/lib.rs` | Component data submission receipt and test-specific observation receiver; use private transmission and existing execution budget, do not obtain permissions from the application writable global, and do not drain additional tasks. |
| `container-runtime/src/lib.rs` | The development package is loaded in the isolation candidate and submitted atomically after acceptance; module registration and successful execution are recorded separately, and failed entries need to be explicitly retried. Host geometry changes revoke old input permissions. Restricted demo releases continue to deny debugging and module calls. |
| `container-runtime/src/route_transaction.rs` | Check whether the Page definition of the real page module is ready before navigation; unloaded routes cannot be executed by using the definitions of other pages. |
| `container-runtime/src/host_services.rs` | Host layout notifications join the runtime-owned API collection; platform providers cannot override this ownership. |
| `container-core/src/lib.rs`, `container-core/Cargo.toml` | Observation modules and exits are controlled by explicit test features and are turned off by default. |
| `container-core/src/finite-notifications.js`, `container-core/src/host-bridge.js` | Object image updates must occur after subscription, sequence, and owner admission; image updates do not become notification authorization sources. |
| `container-core/src/host-environment-install.js`, `container-core/src/lifecycle-notifications.js` | Owner of trusted installation, distribution, and exit phase management host layout notifications. |
| `container-core/src/host_environment.rs` | Installation layout and component receipts, test-specific logs remain private; failure to capture receipts cannot disrupt normal application writing. Full bootstrap byte identity continues to be hard-gated. |
| `container-sdk/src/lib.rs` | The immutable frame snapshot binds the actual accepted physical target and input life cycle, and the development overload uses atomic replacement; the restricted demo continues to prohibit the development load entry. |
| `container-host-web/src/lib.rs` | Bounded binary frames use the existing renderer/frame license; the sandbox must explicitly select development, which is denied for restricted releases. |
| `examples/hosts/web-wasm/worker-runtime.mjs` | Bounded concurrent packet fetching, item-by-item hashing and group cancellation; the hash is still verified after the font cache is read. Frame transfer and scheduling reserve budgets, exclusive tokens, and failure cleanup. |
| `container-host-common/src/lib.rs`, `container-runtime/src/browser_view.rs`, `container-runtime/src/render_backend.rs` | Metadata will be released after the development candidate is accepted; failure can only restore old frames that still have corresponding pages, surfaces, and life cycles. Canceling the operation does not restore the old coordinate input permission. |
| `Cargo.toml`, `Cargo.lock` | Workspace source code license and development and debugging information configuration; Harmony host adds existing SHA-256 dependencies. Licenses and snippets for older released assets remain unchanged. |
| `container-core/src/unhandled-rejections.js` | The test observation interval lasts until the final checkpoint after exit; the public listening distribution is retired immediately upon exit, and the handle cancellation is still valid. By default, notifications after exit are not retained when observation is turned off. |
| `container-core/src/error-notifications.js` | Recursive reporting first disables logs and exception observations, and then stops nested reporting. The checker verifies reachable direct recursion protection to avoid logging missing nested reports as complete evidence. |

The crate paths in the table are all located at `crates/`. The corresponding source, caller, configuration and failure path should be reviewed together, not just whether the method body or keywords exist.

Limited explicit use of non-performance test fixtures for browser owners, browser rendering protocols, and native selectors
2 s View Batch Budget. These use cases hit the 50 ms initialization deadline before entering ownership assertion;
The fixture separates protocol semantic verification from this performance threshold and does not use it to determine the specific cause of the timeout.
The production default value is still 50 ms, and the default loading path of the SDK still uses this value; configure the default value, outer deadline,
Cancellation, interruption and post-failure privilege revocation continue to be verified by dedicated testing. The fixture results do not demonstrate passing the 50 ms performance threshold.

<a id="后续更新"></a>
## Subsequent updates

1. Find the complete source of the last review, review the differences to the current file, and confirm authorization, ownership, life cycle, budget and failure semantics.
2. Fix broken assumptions in the implementation or checker first. Reverse mutation testing is retained; fixture replacements must hit a true and definite number of anchors.
3. Update only reviewed source summaries and AST identities. Only one copy of the shared identity can be retained, and each capability scope continues to explicitly select the source.
4. Run the behavioral tests of `node --test scripts/core-api-inventory.test.mjs`, `pnpm host:services:test` and the affected modules, and then generate and verify the matrix. Comparing all ability statuses, source updates by themselves cannot improve ratings.
5. The actual platform or transaction acceptance must provide additional evidence of meeting the contract; projects that have not been executed will continue to be marked as not accepted.
