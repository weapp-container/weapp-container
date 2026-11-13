<a id="七宿主双渲染-goal-与冻结验收清单"></a>
# Seven Hosts Dual Rendering Goal and Freeze Verification Checklist

[简体中文](README.md) · **English**


The goal is to provide two page renderers—`skia` and `webview`—for Web, macOS, Windows, Linux, Android, iOS, and HarmonyOS, reusing the same AppService, page state, and batch bridge. `skyline-compat` is a Skia-compatible profile and is not a third backend. Web platforms will verify `--web-runtime remote` and `--web-runtime browser`; all other host platforms will operate under mode `native`.

During the planning phase, only installation artifacts and source code audits were performed, and no verification has been conducted to confirm that new renderers, GPU backends, device support, or performance gateways have passed. This directory marks the freeze of the execution scope. The the objective remains incomplete; completion is only permitted when all required gates have been demonstrated with corresponding empirical evidence. Code implementation, interface compilation, existing version screenshots, and checker unit tests do not constitute valid verification for this goal.

<a id="冻结基线"></a>
## Freeze Baseline

- Main branch commit: `c7d0dc6f595cd2d2c0ae2f7cd781c56a6cc6dab9`
- weapp-vite: `0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`
- Official semantic oracle: WeChat Developer Tool `2.02.2608080`, Foundation Library `3.17.3`
- `baseline-v1.json` reads from the above Git objects, preserving the existing API/conformance inventory, 172 IDE case IDs, their statuses and sources, 33 officially passed items, 100 existing runtime API contracts, and the paths and SHA-256 hashes of 282 test scripts, workflows, Rust test entries, and checklists. Parallel workspace modifications do not alter this baseline.
- Each required gate is independently defined by the checker; `gates-v1.json` contains 279 items, all initially in state `unknown`. Reduction of the gate list via deletion, modification of check items, change in evidence type, or reduction in case count is not permitted.
- Official regression requires the 33 previously passed items to continue passing; all other IDE cases retain their original status and source. The full 172 near-parity pass requirements remain under independent gate management. Each host/renderer/Web mode must meet the frozen 100 existing API contracts—partial or unsupported features are to be verified against the documented boundaries and error contracts in the frozen inventory. Existing WXML/WXSS, WXS/modern View, and other source code regression entry points must be preserved and executed. New dual-rendering, component, hardware, and performance checks are independently listed in required gates and cannot be substituted with auxiliary testing to claim official pass.

All host/platforms and Web modes require actual QuickJS execution. V8 retains its existing operational boundaries: Web remote, macOS native, iOS native. These combinations must be re-validated for the new renderer. iOS has existing V8 usage records using a matching local archive; however, this does not imply that a new machine can reproduce the distribution. For all other V8 combinations, explicit engine availability testing is required; if unavailable, return `ERR_ENGINE` and prohibit silent switching to QuickJS. Passing an availability test only verifies error boundaries and does not constitute V8 runtime success. Future V8 support additions require new runtime, component, and performance gates and cannot eliminate existing requirements.

<a id="实施阶段与完成条件"></a>
## Implementation Phase and Completion Criteria

1. Unified frame/resource preparation, on-demand snapshotting, GPU/DOM rendering, and page renderer selection; removal of redundant CPU rasterization/readback in ordinary rendering.
2. Web remote/browser integration with local CanvasKit or DOM rendering; the development simulator continues to share a semantic session, with scenarios and resources batch-distributed.
3. macOS/iOS Metal, Android/HarmonyOS GLES integrate into the new rendering lifecycle; Windows/Linux complete backend integration upon actual host runtime. Skia GPU requests must not silently fall back to software rendering.
4. Both renderers integrate with actual host components: input/textarea editing, Chinese IME, selection region, focus, keyboard, events, and basic accessibility; video playback/pause, seek, mute, loop, fullscreen, events, and release; camera permissions, preview, photo capture, video recording, foreground/background restoration, and device error handling; map functionality using MapLibre with configurable offline styles/data, covering gestures, markers, lines, polygons, events, and explicit GCJ/WGS coordinate conversion.
5. Component size, clipping, transformation, z-order, occlusion, touch, and destruction behavior must be verified; conformance, real device/window interaction, and performance regression must be executed and reproducible before delivery is finalized.

Each of the seven hosts is individually verified—success of seven Rust crates' builds does not equate to successful platform operation. Where no real Windows/Linux window, browser runtime, mobile device, or GPU evidence exists, the corresponding project retains `unknown` or records `blocked` after actual attempts. Software rendering simulators serve only as auxiliary validation; mobile surface/performance completion requires physical device evidence. Existing near-parity gates remain independently enforceable; completion of this goal does not substitute for a full near-equivalence claim of WeChat behavior.

<a id="证据与性能规则"></a>
## Evidence and Performance Rules

Each gate may only use evidence from `passed`, `failed`, `blocked`, and `unknown`. Non-passing items must provide a clear reason. Passing items must point to a SHA-256-bound JSON receipt; the receipt records gate ID, exact source code commit, compiler, and frozen baseline, host/runtime/renderer/engine, actual environment, per-item check results, and the hash of non-empty raw evidence files. A passed receipt must be tied to the actual tested source code commit; previous failed attempts may be retained, but cannot contribute to a pass. `blocked` execution, incorrect engine, or hash mismatch are rejected. Gates requiring hardware GPU must reject software fallback; a passed pack execution does not upgrade to a hardware GPU pass.

<a id="源码与证据归档分离"></a>
### Source Code and Evidence Separation

After testing, evidence submission alters the HEAD. To prevent misattributing evidence archiving as production source code changes, receipts may include the following `sourceBinding`, preserving the original `commit`, and omitting future ungenerated commit SHAs:

```json
{
  "sourceBinding": {
    "version": "1.0",
    "inventory": {
      "path": "docs/evidence/<run>/source-inventory.json",
      "sha256": "<inventory 文件的 SHA-256>"
    },
    "pathListSha256": "<完整受保护路径列表的 SHA-256>",
    "gateDefinitionsSha256": "<冻结 gate 定义的 SHA-256>"
  }
}
```

inventory must be generated by `captureSourceInventory(testedCommit)` from the actual Git tree and must be included in the receipt's `artifacts`. It defaults to protecting all tracked paths, Git mode, and blob/gitlink OID, including runtime, schema, lock files, builders, tests, CI, the checker itself, and submodule pointers; no items can be excluded from the receipt. The checker independently reconstructs the inventory and does not trust path or hash values reported within the file.

Only the following changes permit reuse of prior test results:

- Addition of ordinary non-executable files within `docs/evidence/`; archived evidence cannot be modified, deleted, or converted to a symlink.
- Exact content changes in three specification files: `docs/dual-renderer/README.md`, `docs/dual-renderer/implementation-status.md`, and `docs/dual-renderer/browser-dev-loop.md`. File deletions, renames, and mode changes are not permitted.
- Changes in `gates-v1.json`'s `status`, `reason`, and `evidence`; the full descriptor, list order, count of 279 items, and all checks must remain exactly identical to the frozen definition of the checker.

Accepted submissions must be descendants of the original test commit. The checker examines every commit and merge parent→child diff between the two, and verifies the full inventory at endpoints. Any production change followed by a revert, or a branch change followed by merge, cannot inherit prior results merely because the final byte content is identical. Any change to source code, dependencies, build, test, CI, or the checker itself requires re-execution on new source; old screenshots or receipts cannot be reattached with new SHA values. This rule also implies that a commit introducing this checker does not automatically grant new pass status to prior browser results.

The CLI always validates the real expected commit and the current HEAD checkout/index, even when a historical `--expected-commit` is specified, the list is entirely unknown, or the receipt has no new binding. Verification directly reads file bytes, executable bits, and symlink targets, and recursively validates initialized gitlink checkouts; it does not rely on Git status potentially hidden by `assume-unchanged`, `skip-worktree`, `core.fileMode`, or submodule ignore settings. Source code proof is limited to 16 layers of gitlink, 200,000 entries, and a 1 GiB read budget; exceeding these limits results in explicit failure. Current workspace mode proof requires a POSIX file system; native Windows checks will explicitly return "cannot prove" and must be executed on a complete POSIX checkout for evidence validation. Legacy exact-commit receipts do not require new binding; dirty checkouts are still invalid.

Git blob identity preserves original bytes and OID; normalized results are not written back to inventory. Checkout must default to matching blob bytes; the only additional allowed materialization is when a specific immutable tree's `.gitattributes` explicitly declares `text eol=crlf`, and the regular file is exactly the canonical CRLF version of the LF blob. Mixed line endings, bare CR, NUL-containing conversions, content changes, `text=auto`, or differences caused solely by `core.autocrlf` are all rejected. Attribute parsing uses Git's `--source=<commit>`, supporting hierarchical rules and macros for tracked paths; global/system attributes are excluded, and any local `info/attributes` results in explicit rejection. The presence of `filter`, `working-tree-encoding`, or `ident` in Git `--all` results is rejected outright, including explicitly disabled cases or filters named `unset` or `unspecified`, to avoid ambiguity in boolean and string output. The checker does not invoke content-aware `git status` or any clean/smudge filter: full index and direct byte proofs cover tracked files, and additional files are only accepted if explicitly listed in `ls-files --others --exclude-standard`. This rule is recursively applied to fixed submodules, and vendor files are not modified to accommodate validation.

`inspectChecklist()`'s default pure structural mode is provided for synthetic schema unit testing; the actual CLI permanently enables `verifyCheckout: true`. These checks only verify source code and archive relationships and do not validate the authenticity of original logs, screenshots, or human assertions. They do not replace or substitute real browser, official tool, GPU, or device execution.

Performance scenarios are fixed at 1000 nodes, 10,000 setData entries, 1000 items in a scrollable list, and 20 mixed network requests, using release builds and preserving at least 20 samples. Web and browser remote validations are performed at 375×667 and 2× resolutions, verifying input to presentation with p95 ≤ 50 ms. First-frame p50: Web/desktop ≤ 500 ms, mobile ≤ 900 ms; all p95 ≤ 1500 ms; setData p95 ≤ 8 ms; bridge p99: Web/desktop ≤ 2 ms, mobile ≤ 5 ms; scroll frame drop rate under 57–63 Hz input is ≤ 1%; steady-state memory: desktop/Web ≤ 150 MiB, mobile ≤ 120 MiB; QuickJS incremental growth ≤ 8 MiB, V8 recorded and meets platform budget. Cold/heat startup must also be recorded. The checker validates numeric values and evidence bindings, does not perform the test, and does not independently verify the observed truthfulness of the receipt; manual and automated harness validation of evidence remains necessary.

```sh
# 验证冻结清单和证据格式；成功仅表示清单有效。
node scripts/check-dual-renderer-gates.mjs --validate-only

# 完成门禁：任何 unknown/blocked/failed 或失效证据均非零退出。
node scripts/check-dual-renderer-gates.mjs --expected-commit <exact-40-character-commit>

# 检查器本身的回归；不运行浏览器、设备或官方 oracle。
node --test scripts/check-dual-renderer-gates.test.mjs scripts/check-dual-renderer-source-binding.test.mjs
```

The default expected commit is the current HEAD. `--validate-only` does not modify state, does not populate pass items, and does not grant releaseReady. Report files and original evidence must be generated and reviewed by the corresponding harness after implementation; handwritten pass declarations cannot substitute observed results. All `unknown` in the current list explicitly indicate that no evidence has been submitted for acceptance of this new target commit.
