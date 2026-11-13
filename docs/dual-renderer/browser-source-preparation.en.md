<a id="浏览器开发态的受管构建输入"></a>
# Managed Build Inputs for Browser Development

[简体中文](browser-source-preparation.md) · **English**


> This page records the low-level contract; these APIs do not enable the development CLI. Full runner, startup parameters, and shutdown restrictions for explicitly reused Browser CLI are documented in [Browser Development Loop](browser-dev-loop.en.md).

`DevConfig.managed_browser_sources = true` integrates the compiler watch, raw output snapshot, and portable packaging into the existing `BrowserWorker` supervisor. It requires explicit provision of an independent producer and hash from `browser_runtime`, using QuickJS and a fixed submodule `0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`. The default development mode continues to use the existing pipeline.

```sh
cargo run -p container-simulator --example prepare_browser_runtime -- \
  examples/apps/reference-app /absolute/completed-worker-producer \
  /absolute/independent-pins.json --owned-sources
```

Pin file format is specified in [runtime input](browser-dev-artifacts.en.md). The example first receives a static runtime receipt, then waits for `PortableReady`, validates the release validity at that point, and finally retries cleanup on the same supervisor. This entry does not start HTTP, Worker, or browser instances; `runtimeReady` and `presentedReady` remain false.
`--web-runtime browser` still requires full execution chain validation. No stage, activation site, or GPU/performance verdict is generated here.

<a id="数据和资源归属"></a>
## Data and Resource Ownership

The supervisor only starts its own watcher after full construction. The source protocol `2.0` uses a single atomic replace via `status.json`, with a decimal string index to avoid JS Number precision loss. Source state is divided into building, success, error, and blocked; only after actual success END, issued grant, matching writer-done receipt, compiler pin, and full directory list validation can immutable raw input be obtained.

Grants precede copy admission. Copy completion and handle closure must occur before writer-done confirmation; if closure result is uncertain, the same watcher ends, and write access is released by the Rust-held process tree barrier. Unused grants can be revoked via atomic renaming. Missing, corrupted, or erroneous ACKs cannot authorize premature deletion; cleanup proceeds only after actual watcher barrier success, and no longer depends on damaged ACKs for cleanup.

Capacity recovery retries releases under END and build state constraints within the same compiler context/watcher, and does not create new contexts due to new grants. The public `closeAll()` of the fixed compiler consumes internal close failures—here it is used only for best-effort close; it does not constitute writer exit evidence. On first context, npm, or build call failure, this managed mode terminates the process and requires restarting the supervisor; normal watch build errors can be recovered and resumed on the same watcher. Final failure exits the Node wrapper, and sub-processes remain under confirmation of exit by the Rust-owned original process tree owner before input deletion. Retries in default development mode remain unchanged.

The packager holds the true borrower of raw input until actual child process exit and independent portable validation completion. Timeout, creation failure, and validation failure all retain the original owner for cleanup. Successful output inherits the same namespace and cost, and is published via `.staging → pack`. New build errors invalidate the publish token; previously valid packs remain intact. Cleanup traverses all dependencies and cannot skip a packager due to ongoing borrowing of raw input.

Watchers, portables, and runtimes share the same ledger. The following numbers represent logical admission policies and **cannot be interpreted as actual RSS, Node heap, disk hard quotas, or performance metrics**:

| Item | Max Count | Per-item Memory Policy | Per-item Disk Policy |
|------|----------|------------------------|------------------------|
| root / producer / tools | 1 | 512 MiB | 512 MiB |
| runtime | 1 | 1024 MiB | 512 MiB |
| raw | 2 | 32 MiB | 256 MiB + 64 KiB |
| portable | 2 | 256 MiB | 512 MiB + 64 KiB |

Explicit source profile limits are set at 3 GiB memory and disk, 81,984 files, 10,286 directories, 6 namespaces, and 1 limited artifact job; default retain-only limits remain unchanged. Compiler-generated mutable outputs remain under independent preparation ownership and are not claimed to have hard quotas under this table. The actual process tree of persistent watchers is managed separately and does not claim serial permits for limited packaging jobs.

Current source profile explicitly rejects custom `wv`, unknown compilers, and any `container.config.json`, including modern View sidecar; it has not yet admitted their source code or dependency closure. The compiler Git pin serves as version origin, not as proof of truthfulness of untracked build files on the host. Source code for watch/packer must be bound to execution evidence; this stage does not claim completion of full browser site input freeze.

<a id="后续执行门禁"></a>
## Next-stage Execution Gatekeeping

The next stage requires the consuming stage to physically hold portable, runtime, tools, and parent inputs, and to obtain separate admission for temporary copies and peak loads against the previous site. Only after real browser execution completes these paths can independent browser development mode be opened.
The seven-host and official near-parity gatekeeping continue to be separately recorded.
