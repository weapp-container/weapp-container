<a id="现代-jsts-view"></a>
# Modern JS/TS View

[简体中文](modern-view.md) · **English**


Modern View is a container-activated synchronous ES2022 execution mode. The original `.wxs` continues to use the [WXS compatibility path](isolated-view-engine.en.md), with both creating independent QuickJS/V8 realms. Modern modules use standard JS properties, constructors, and object identity semantics, without going through WXS helper or per-function parameter copying.

<a id="直接开发"></a>
## Direct Development

Run after preparing dependencies at the root of the repository:

```sh
pnpm install --frozen-lockfile
pnpm modern:view:typecheck
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/modern-view-app --surface web
```

Fixed vendor builder preparation steps are described in [Simulator Documentation](simulator.en.md#开发态监督器).
Desktop window uses `--features quickjs-native,desktop-window` and `--surface desktop`;
Dual panel uses `--surface both`. V8 uses `--features v8-native` and `--engine v8`.
Explicit failure if the selected native engine is not included, no fallback.

[Example](../examples/apps/modern-view-app) includes TS, ESM shared dependencies, destructuring, optional chaining,
private fields, Map/Set, generator, enum, BigInt converted to string, and legacy WXS subcomponents.
Editing `view/format.view.ts` can trigger standalone updates for modern source code. Modern executable changes will restart the session,
compilation failures retain the latest successful generation and display diagnostics.

<a id="选择文档与模块"></a>
## Select Document and Module

The `container.config.json` in the project root directory maps to **wv output WXML path**:

```json
{
  "view": {
    "documents": {
      "pages/home/index.wxml": {
        "mode": "modern",
        "modules": { "fmt": "./view/format.view.ts" }
      }
    }
  }
}
```

WXML uses `{{fmt.format(value)}}`. No `<wxs>` is needed; modern mode is required for all documents and their reachable import/include graphs. The builder combines all aliases in the entire graph into a single execution unit, preserving shared dependency singleton, ESM live binding, and cyclic dependency semantics. Cross-mode import/include or module imports explicitly fail. Modern pages and legacy components can be combined via props, events, and slots; projected content retains the semantics declared in the original document.

`.view.js` / `.view.ts` is a development convention, modules are explicitly included via configuration. Modern sources do not go through the upstream WXS transpiler.
Pure computation npm dependencies use project node_modules resolution; Node built-in modules, network imports, and `.wxs` dependencies are disallowed.
Dependencies also undergo synchronous syntax checking and cannot rely on browser, Node, or AppService globals.

Module import supports relative paths (JS/TS extension can be omitted) and public entry points of npm packages.
Modern bundlers do not read the project's `tsconfig.json`, nor inherit its `paths`, `baseUrl`, or project references;
aliases in `container.config.json` are WXML module names, not module path aliases.
This enables freezing source snapshots without copying the `.weapp-vite` generated configuration to achieve identical resolution results.

Supports ES2022 synchronous syntax, static ESM, iterators, synchronous generator, TS type erasure, and regular enum conversion.
`tsc --noEmit` handles type checking independently; a successful build does not guarantee type checking passed.
async/await, Promise task scheduling, dynamic import, top-level await, decorators, namespace, and TSX are not supported.
Network, timer, and host capabilities are handled by AppService. These language limitations do not constitute a secure sandbox for untrusted code.

<a id="数据和执行边界"></a>
## Data and Execution Boundary

Each page/component batch copies data only once. Modern functions can modify this batch snapshot, and subsequent expressions will observe the modifications; the original data in AppService remains unaffected. Module state is retained per page/component occurrence and is released when instances are removed.
WXS functions still retain the original parameter copy semantics.

Map、Set、Date、RegExp、BigInt、instance of class and functions can be used within modern modules; they must be explicitly converted to verifiable plain data before entering rendering attributes. Functions, cyclic objects, BigInt, Map, and similar cannot be used as final rendering values; they will not be silently converted via `toJSON`. Only fully successful batches are submitted. The JS heap state is not rolled back for any previous frame.
UTF-16 is still used internally in JS; isolated surrogates in rendering output will explicitly return `ERR_VIEW_UNSUPPORTED_VALUE`, and exception text will retain visible escaping to avoid corrupting cross-language transmission.

The transport captures internal operations in advance and uses separate containers. User code may modify standard built-ins while subsequent validation, error reporting, and cleanup remain protected. Both profiles group work by whole-document frontier and share one overall deadline and cancellation token, without per-node or per-function round trips to Rust. Timeout, cancellation, or unconfirmed cleanup requires a session restart.

<a id="pack-与宿主"></a>
## Pack and Host

Self-contained:

```sh
node tools/container-manifest/bin/container-pack.mjs path/to/raw-weapp \
  --project examples/apps/modern-view-app --out artifacts/modern-view \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
```

Original `wv build` directory remains unchanged, portable pack separately saves modern programs, original sources, and sourcemaps.
The development debugger places the original output, receipt snapshots, and frozen source code outside the project into a dedicated temporary directory, and cleans up upon exit;
The user-specified `--out-dir` only holds the generated published pack, and can retain the default in-project directory;
Build temporary files do not enter the source code watch tree. Real watch smoke separately covers both in-project and out-of-project published directories.
Modern pack uses schema v2, declaring the `modernView` compiler `weapp-container-modern-view@1.0.0`, ABI `1.0`, and target `es2022`; pure legacy mode continues using schema v1. Legacy runtime cannot load v2.
All source code, programs, and maps use SHA-256 and are included in manifest integrity.
Module, configuration, profile, dependency graph, and stateful template changes trigger session restart; safe style/resource updates can still be replaced in-place.

The original WeChat product can still be opened by official tools; official tools will not obtain this container extension. The modern mode follows standard JS, dual-engine, and host testing acceptance, and official WXS compatibility still relies solely on real DevTools oracle.
Testing on development machines does not guarantee passage through the gates for seven hosts, GPU, real devices, or near-parity releases.

<a id="验证"></a>
## Verification

```sh
pnpm container:manifest:test
pnpm modern:view:typecheck
node --test crates/container-core/tests/modern_view.test.mjs
cargo test -p container-runtime --test modern_session --locked \
  --features quickjs-native,v8-native
cargo test -p container-engine-quickjs -p container-engine-v8 --locked \
  --features container-engine-quickjs/quickjs-native,container-engine-v8/v8-native modern
```

Specialized performance goals are equivalent hand-written modern JS hot rendering p95 overhead no more than 5%, and stable fallback of old WXS no more than 5%.
Initialization, compilation, batch transmission/execution, memory, and package body are separately reported; development machine results do not substitute the original host performance threshold.

[2026-10-22 Implementation and Verification of Evidence](archived-evidence.en.md) retains dual-engine semantics, real watch, headless display/error recovery, and relative performance report for one release/1000 samples, including historical failure records.


Native relative performance comparison can be directly reproduced:

```bash
pnpm modern:view:perf                         # 默认 release
pnpm modern:view:perf --profile debug         # 快速开发检查，报告明确标记 debug-test
pnpm modern:view:perf --samples 1000 --out-dir artifacts/modern-view-performance
```

The script first verifies that TS and the handwritten JS fixture originate from the same public compiler, then sequentially runs QuickJS, V8, and the real ViewEngine. The historical WXS bootstrap is statically taken from
`081f878808075cfe9c2f1e2025ca97f2a4a9f956`, and temporary copies are cleaned up upon exit.
The p95 ratio of TS/handwritten JS and cached vs. historical WXS hot-rendering batches for both engines must be ≤ 1.05; if either threshold is exceeded, the script returns failure. Reports are retained in the output directory as `quickjs.json`, `v8.json`, and `summary.json`.

Timing includes realm initialization, full loadModules, and render batch after preheating (transmission, execution, normalization, and Rust decoding), and does not equal pure JS function execution time. RSS is the entire test process including the history of four engine instances and allocator; the test binary size is for diagnostic purposes only and cannot be considered a production runtime incremental bundle.
Relative regression checks on development machines do not replace absolute performance acceptance on real DevTools, GPU, devices, and host environments.

<a id="ci-专项验证"></a>
## CI Special Verification

[`modern-view` workflow](../.github/workflows/modern-view.yml) and `container-ci` both only accept
manual runs; pushes/PRs will not trigger. Go into the repository's **Actions → modern-view → Run workflow**,
select the branch and `suite`: `browser` (default) to perform development builds and browser regression, `performance` to perform only release performance regression, `full` to perform both sets simultaneously. `suite` replaces the old boolean input `performance`.

```bash
gh workflow run modern-view.yml -f suite=browser
gh workflow run modern-view.yml -f suite=performance
gh workflow run modern-view.yml -f suite=full
```

Commands default to the repository's default branch; other branches can be specified with `--ref <branch>`.
The `scope` for `container-ci` and OS selection are as described in the [Host Validation Documentation](host-validation.en.md#手动-ci);
The two workflows run independently; running the `full` step in one does not imply the other has been executed.

Browser group installs locked dependencies via Node/pnpm declaration of fixed submodule and executes `build:pkgs`,
builds the original WeChat artifact for modern examples, and separately generates schema v2 pack. The artifact retains both,
enabling verification against public compiler outputs and container extension boundaries.

The same dual-engine simulator binary sequentially executes QuickJS, V8 headless Chromium smoke,
checks first frame, modern source code reload, mapping to TS runtime exceptions, retention and recovery of the previous frame. Each call only creates
its own temporary project, loopback server, browser/context/page, and closes them in `finally`, reporting with `headless: true` and cleanup results; failure during cleanup also causes job failure. Failure reports and screenshots are always uploaded.
This binary explicitly enables `skia-raster`, the runner installs Fontconfig, FreeType, and DejaVu fonts;
retains assertions for real text pixel and visual changes after text modification, without using fallbacks that only draw boxes or images.

release performance measurement selects `suite=performance` or `suite=full`
uses a fixed WXS baseline from the full Git history and 1000 sample batches after pre-warming.
QuickJS/V8 each individually, for TS/hand-written JS, cached/historical WXS p95 ratios exceeding 1.05, or build/report validation failure, the job will explicitly fail and upload the existing JSON, without silently accepting rollback or raising thresholds.
The shared runner's CPU scheduling and frequency affect results, thus it serves as a reviewable diagnostic, not as a hard performance gate for each PR; formal acceptance still requires retesting on a fixed machine.

A workflow/ref/suite run in the `browser` group cancels the old run; `performance` and `full` do not cancel ongoing runs of the same type, but GitHub's concurrency queue may replace a pending run that has not yet started.
Download cache reuses dependencies only and does not cache build artifacts or evidence. Browser artifacts are retained for 7 days, performance artifacts for 30 days; long-term evidence still requires explicit archiving. Suites not selected do not count as passed.

These reports only verify the actual execution of containerized development UI and native View batch scenarios, do not add real DevTools, GPU, official emulator, physical device, or near-parity release pass states, and do not alter the already frozen evidence and gatekeeping list.
