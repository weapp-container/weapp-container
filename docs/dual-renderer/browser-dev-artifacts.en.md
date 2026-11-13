<a id="浏览器开发态构建资源"></a>
# Browser development state construction resources

[简体中文](browser-dev-artifacts.md) · **English**


This layer of implementation separates build and releaseability from runtime preparation. The static Worker product has evidence of real execution; the common development CLI's explicit `webview + browser + web + quickjs` has reused the same managed runner, and other Browser combinations are still explicitly rejected. Managed stages, original owner's resource leases, authentication controls, and experimental development UI have been wired through a standalone `serve_browser_dev` example; final r5 has implemented real browser bootstrap, watch, fail retention, and precise shutdown, with evidence and static production results logged separately. For experimental entry and restrictions, see [Browser Development Cycle](browser-dev-loop.en.md).

<a id="pack-消费者"></a>
## Pack Consumer

`DevConfig.pack_consumer` Defaults to `LocalRuntime`, preserving remote emulator behavior. `BrowserWorker` Generates only immutable portable packs, reuses native-mode manifest integrity root and blob checks, and emits `DevEvent::PortableReady`. It does not create a native JS engine, session or screen, and `pump_runtime` does not perform work. V8 returns `ERR_ENGINE` before the watcher starts.

`PortablePackReport` contains the pack path, manifest/root/compiler, route and independent publication token. Compilation failure or new input does not remove the last valid pack. The same byte recovery can reuse the generation, but a new token must be obtained, and the old completion result will still be invalid.

<a id="监督器的静态-runtime-准备"></a>
## Static runtime preparation of supervisor

The embedder can set `DevConfig.browser_runtime = Some(BrowserRuntimePreparation { producer_directory, expected })` for `BrowserWorker`. `expected` must be independently selected from the completed Worker producer record before starting the consumer, including original report SHA-256, source commit, source inventory SHA-256 and renderer. The original producer must be a canonical directory and separated from the project, output and temporary preparation roots; incorrect configurations will be rejected before starting the watcher. The default `None` does not create this resource chain, nor does it change the original pack-only or remote path.

`spawn` only creates a statically prepared metadata owner; the first time `poll` obtains the exclusive directory, freezes the bounded producer copy, creates an embedded tool snapshot, and starts the real retain job after capacity admission. Replies up to 256 MiB, 16,384 files, 2,048 directories, 64 layers, single file up to 64 MiB; rejects symlinks, special files, and very long paths. The fixed input/tool ​​slot independently reserves 512 MiB of memory and 512 MiB of disk for logical policy fees; the runtime store also has two namespaces, a limited job slot, and 64 resource borrowings per namespace, each of which reserves 1 GiB of memory and 512 MiB of disk policy fees. These charges do not actively allocate corresponding memory, nor are they hard caps on allocators, Node RSS, file system quotas, or the entire emulator server.

The supervisor advances the limited job before the source event exits early, consuming the real completion and validating the original receipt. Successfully issued `DevEvent::BrowserRuntimePrepared`; where `runtimeReady`, `presentedReady` are both `false`. `browser_runtime()` queries static reports, `browser_runtime_resource(&mut self, path)` only lends out the original shared bytes within the fixed allowlist, and does not re-read or copy the entire payload. source, report, parser and old bootstrap are not exposed through this interface. This preparation is independent of the freshness of the app source and does not replace `check_portable_publication` or the app site's stage/activation.

Failure diagnosis is only reported once, and subsequent polling continues to advance the shutdown/cleanup of the original limited job; deadlines and process recycling are not stopped because errors have been reported. The producer/tools root is still retained by the original owner until explicitly closed. Normal exit calls `try_shutdown()`: active resource borrowing causes it to return `Ok(false)`, cleanup errors return `Err`, both retain the same owner. The borrow can be retried on a stopped supervisor after releasing it, and `Ok(true)` will not be returned until actual store drain, tools cleanup, and exclusive root deletion are complete. The original `shutdown()` remains callable and outputs diagnostics that need to be retried when not completed; Drop is not a proof of successful cleanup.

Runnable embedding example:

```bash
cargo run -p container-simulator --example prepare_browser_runtime -- \
  examples/apps/reference-app /absolute/completed-worker-site /absolute/independent-pins.json
```

pin files use `{ "expected": { "reportSha256": "…", "sourceCommit": "…", "sourceSha256": "…", "renderer": "software|canvaskit" } }`. The example prepares and reads the runtime configuration via real `DevSupervisor` and then shuts down explicitly; it does not start HTTP, workers, browsers, or GPUs. Producer copies, tools, and original jobs are always held in their entirety by a private owner. Subsequent managed stages have used the actual portable/runtime input lease and limited job scheduling of the same aggregate ledger, and cannot treat paths or reports as leases; HTTP and development UI are accessed by the original `WebSurface` of independent opt-ins.

A new site cannot be provisioned or activated until `check_portable_publication(&mut self, &report)` is called. It is not subject to daily watch anti-shake restrictions and immediately observes receipts, source configurations and modern View dependencies; it also compares raw input when there is no pending build, and legal raw modifications must wait for a new compilation receipt. Returned diagnostic events must be fed into the existing overlay/history stream. It only proves freshness at the time of the check and does not lock the file system, pause existing workers, or grant run or input permissions. Pending modern builds self-verify complete dependency closures to avoid mistaking new purely computational dependencies for having to rebuild upstream products.

<a id="可复用-runtime"></a>
## Reusable runtime

`scripts/browser-dev-artifacts.mjs` provides three internal build APIs:

- `retainBrowserRuntimeBundle` Preserve a subset of the runtime from a clean Worker build from a standalone pin.
- `openBrowserRuntimeBundle` Re-verify the reserved descriptor and complete file list, and return to the in-process handle.
- `stageBrowserPackGeneration` pairs the new pack with the verified runtime, generating pack-index, product config, and `site.json`; does not call Cargo/bindgen.

The caller provides the original build-report exact SHA-256, source commit/source hash and renderer. These pins should be obtained from real producer execution records; self-hash calculation of arbitrary directories does not constitute proof of producer authenticity. Helper rechecks source code, generates pkg/snippets, fixed Acorn, static module closures, WASM exports, glue interface raw receipts, CanvasKit/font pin. It compiles WASM to check exports, does not instantiate the application WASM, does not rerun the glue interface, and does not run AppService. Static closure checks do not constitute a safe sandbox for arbitrary JS.

The coordinator only retains the four runtime identities that actually exist: `bundleSha256` is the original `runtime-bundle.json` byte hash (not the logical bundleId), `producerReportSha256` is the unmodified original `build-report.json` byte hash, `sourceCommit` is from the standalone producer pin, and `sourceInventorySha256` corresponds to `sourceSha256` of the existing producer. The latter takes UTF-8 `JSON.stringify(report.source.sourceFiles)`, verified by the fixed Node helper; it is not the `source-snapshot.json` raw file hash, and cannot be replaced by Rust reserialization. There is currently no separate runtime sourcemap, toolchain or renderer aggregate receipt, and the interface does not require such hashes to be filled in. Source pin and bundle closure checks must still be performed, field shape checks cannot replace them.

The original build-report is retained as it is, and the absolute path in the original report is only used for historical context. The bundle is not a complete build forensic directory: command logs, raw linker WASM, old pack-index, etc. continue to be archived by the original producer. Source files, reports, parser and old bootstrap do not enter the runtime's serve allowlist; resource reads return copies.

The output must be an exclusive new directory. Before creation, the existing ancestors are checked to be canonical and unsymbolic links. Overlapping with the input tree is prohibited. The read itself has a limit of single file/total bytes/number of files. It does not rely on one stat to constrain subsequent unbounded readFile; the portable input captures the private snapshot of this task and then hands it to the existing validator. During the call, the output directory and runtime source snapshot are exclusive to this operation and cannot be replaced by other writers. If it fails, only the newly created directory will be cleared, and existing targets will remain intact.

Single file 64 MiB, manifest 2 MiB, report 16 MiB, single retained inventory 256 MiB; this is not an RSS cap or server global cache budget. Managed runtimes, portable inputs, stage jobs, and the original body lease are now retained by the same aggregate ledger to retain fees and reclaim identities; HTTP requests, controls, and shared responses are additionally subject to the bounded budget, connection caps, and deadlines of the original `WebSurface`. The two-tier contract cannot be confused with a hard memory cap for the entire process or file system.

Pack generation count and token use precise decimal u64 strings to avoid browser Number precision loss. The generated results are fixed to `publication: not-authorized`, `runtime: not-run`, `presentation: not-run`; Rust source barrier, preview lease, actual Worker ready and final rendering ACK are respectively accepted. Build failures preserve the old pack with running instances; new startup failures after the old Worker is shut down cannot claim to preserve the old JS heap.

<a id="发布与控制回执"></a>
## Release and Control Receipts

`browser_dev_coordinator` only maintains a stage, offer, activation, owner and close that may be executing. It does not read files, start workers, or release resources. `accept_portable` and `finish_stage` require approval from the immediately executed supervisor check; when accessing the owner loop, the source input must also be checked immediately before `issueActivation`, `beginActivation` and `startOwner`, and cannot only rely on watch anti-shake or previous permission.

The original UTF-8 JSON hash of the launch intent differs from the actual generated `worker-product-config.json` hash: the actual configuration also binds pack-index and the valid route selected by the supervisor. Both the configuration module and JSON are entered into the generated file manifest, and the independent product checker requires that their content be consistent. pack URLs use the run/site double immutable namespace; the same pack cannot borrow the last configured URL.

`browser_dev_control` Strictly decodes bounded requests for the same registered client, retaining exact final bytes. The HTTP enqueuing receipt is not the execution result; retry must query the final of the original requestId, and the original operation cannot be repeated. Normal commands use `<client>:control-N`, and cleanup commands use `<client>:cleanup-N`. Each retains the serial number high water mark, index, and capacity budget; exhaustion of ordinary serial numbers cannot block cleaning, and no space may be wrapped or reset. The maximum final capacity is reserved before execution; the request number high water mark prevents the removed old command from becoming a new operation again. The prepared final can submit reserved bytes with the original execution ticket, and the original operation cannot be re-executed. The authenticated HTTP adapter now provides invoke, exact replay and raw byte hash ACK, and operates on the same `BrowserDevOwner` raw ledger. The manager will send an ACK only after it has been fully adopted, and it shall not automatically compress the final after it is successfully sent. Independent `observe` is a read-only original typed snapshot and does not occupy the command serial, final or ACK capacity. Status, retry and cleanup boundaries are described in [HTTP Control Access](browser-control-http.en.md) and [final ACK](browser-control-ack.en.md).

Still allows exact owner cleanup after stopping. When normal control sequence numbers are exhausted, independent `terminalCleanupRevision` is used to sort and clean up the status, and startup permission cannot be re-granted. The browser's ready, rendering and cleanup records are all marked `browser-reported`; controlling final only confirms that the coordinator accepted the report and cannot be used as independent device evidence.

<a id="有限工具作业"></a>
## Limited tool operations

`browser_dev_artifact_job` Perform a single retain or stage using a snapshot of the five-member Node tool compiled into the simulator. Scripts, entries and complete static dependencies are verified in private directories, and application pack and retained runtime are additional data inputs for verification. The job does not execute Cargo, application JS, workers, browsers, or services. Requests can be up to 2 MiB and results can be up to 16 MiB; the output can only be `output` in a directory exclusive to this job, and the cleanup path cannot be specified by an HTTP request.

Jobs have absolute deadline, canceled and supersede status. An exit code of zero and a late complete result cannot undo the stop state. Unix requests to terminate the owned process group before recycling the group leader PID. Windows uses Job Object; the result is read and the file lease is transferred only after the actual group/Job cleanup is confirmed. The Unix contract requires that trusted tools remain in the process group and are not descended from the process sandbox of any program.

If the construction fails, the cleanup owner must also be retained: failure to fill the private directory returns the lease of the directory, and failure to write the owner marker after starting the child process returns the actual job. Windows establishes the complete owner before allocating the Job or resuming the suspended thread; still returns the actual Child/Job when these steps fail, cleans up while trying two stable handles, and confirms that the child process exits and the Job is cleared. The caller retains the error and its capacity reservation, calls fallible cleanup repeatedly, and releases the job reservation only after confirmation. The sharing tool only releases this borrowing; snapshots used by other owners continue to be held by their leases. Dropping logs or recovery paths does not count as cleanup completion.

The process exit check of job `poll` is not blocking; the bounded file read after completion is still synchronous I/O, and the entire job polling cannot be claimed to be completely non-blocking. Existing managed jobs, generations, shared tools, and artifact leases still held by the HTTP body after disconnection continue to retain the original aggregate charges; HTTP wires and replies are accounted for separately by the surface. Single-job caps, aggregate logical reservations, and HTTP budgets each have their own bounds and cannot be substituted for each other or considered RSS proof.

<a id="rust-静态-runtime-回执"></a>
## Rust static runtime receipt

`browser_dev_runtime_receipt` Binds `PendingRuntimeReceipt` to the actual job's file owner, original request byte hash, and standalone producer pin before polling the job. It consumes the true completion of the job, checking exit/stop status, raw result, bundle and report bytes, as well as the full resource inventory of the fixed consumer closure. The directory in result is only used for comparison and cannot be authorized to read other directories; the source inventory is still verified by the fixed Node helper according to the original recipe, and Rust does not reserialize it to generate pins.

Success receipts retain the original result, bundle, report, and validated immutable resource bytes. Resource borrowing holds the actual file lease, so the body that is still being sent after the receipt is retired will prevent exclusive cleanup; on failure, the original completion is returned for the owner to explicitly retry the cleanup. Source files, reports, parser and old bootstrap do not go into the resource serve manifest. A single capture includes descriptors, up to 256 MiB; there are other limits for single files and lists. The original resource is now enqueued into the original owner lane via a strictly immutable GET of `WebSurface`, and the response holds the same store borrower until actual write, failure, or timeout, and is not copied to the new artifact owner. These connected fees and leases are still not the upper limit of the total memory of the process.

Both job and receipt reading first check the file length, then allocate and read through the same exact-size helper; extra bytes are only detected using stack probes, and file growth will not trigger `Vec` expansion. Continue to verify metadata and file identity after reading. This path is still statically verified and does not grant publication, worker ready, rendering, or GPU permissions; synthetic receipt single testing cannot replace the real producer verification of independent pins.

The independent integration entrance of the real producer is `crates/container-simulator/tests/retained_runtime.rs`. The default test marks it as ignored; `--ignored --exact independently_pinned_worker_runtime_is_retained_and_cleaned --test-threads=1` must be run explicitly. Entry requires `WEAPP_CONTAINER_RETAINED_RUNTIME_` prefix for `BUILD_SITE`, `REPORT_SHA256`, `SOURCE_COMMIT`, `SOURCE_SHA256`, `RENDERER`, `NODE_BIN`, `EVIDENCE_PARENT`, and `PIN_AUTHORITY`, failing when running explicitly with missing arguments. It is expected that the pin should be selected from the standalone producer execution record before starting the consumer, and cannot be backfilled from the directory to be verified or the current child process. The entry retains the original byte evidence to verify the real Node job and the cleanup barrier borrowed by the body; only the actual execution results can mark the item as passed.

<a id="浏览器-owner-与绘制资源"></a>
## Browser owner and drawing resources

`browser-dev-owner-manager.mjs` prepares the actual drawing resources after metadata admission and before closing the old owner. DOM pages skip CanvasKit; external frame paths go through the same admission loader that verifies six fixed resources, initializes CanvasKit, and verifies the creation and release of temporary fonts. The static preparation lease does not contain owner permissions, and only the matching loadResult of the real `WorkerWebSession` can lend out the independent drawing lease.

The loader sets limits on waiters, static leases, owner leases, font copy bytes, and initialization times. Cancellation waits for the actual initialization and cleanup to be completed, and subsequent DOM activation cannot bypass the unfinished resource release. Modules remain in the loader cache; there is currently no guarantee that the CanvasKit module will be completely destroyed. Initialization and font preparation do not prove successful GPU surface, actual rendering, input, or application launch.

manager retains precise control over requests and original finals, and handles cancellations, late results, and uncertain closures. Replacement can only start the new owner after the old owner's true closing barrier has passed. Runtime ready and acceptance of the current rendering are reported separately; HTTP success, worker created, frame generated, or screenshot are not substitutes for rendering confirmation. The manager itself is still not responsible for page and HTTP services; the new `BrowserDevApplication`, authenticated HTTP client and opt-in `WebSurface` UI will connect it to the development cycle; the ordinary CLI reuses the runner without creating a new owner or relaxing artifact access.

<a id="实验开发页面与交付边界"></a>
## Experimental development page and delivery boundary

Trusted native startup can enable control and control before the original resource-only loopback surface accepts for the first time.
`enable_browser_dev_app`. The root page only embeds the inert JSON of the original auth and original preview; fixed development
Assets do not go through the file system fallback, all UI/resource GET accurately checks the original Host, and the response continues to use the same
HTTP budget and deadline. See [HTTP Control Access](browser-control-http.en.md) for the complete service, credentials, and shutdown policies.

`serve_browser_dev` example will fix compiler watch, portable pack, stage and original owner
Receiving this page; the current experimental entrance is limited to QuickJS Worker + DOM/WebView, and the browser will not be opened automatically.
Real bootstrap, update, import, fail retention and original manager shutdown have been performed by final r5, see the original record
[Development cycle evidence](../archived-evidence.en.md). This verification only performs a limited
DOM/QuickJS development cycle, compilation, contract unit testing and previous static product results are still retained separately.

This is a limited lifetime development cycle. `observe` does not accumulate commands, but owner switches and ready reports
Still consumes limited command and receipt budget; cannot obtain unlimited by background eviction, ledger reset or mutation replay
watch. After the page is refreshed, crashed or lost, the new page cannot restore the original manager, worker and close barrier.
There is no takeover or automatic release after disconnection. Should stop on the original page and complete the original owner, ledger ACK and HTTP
Drain and then start the service again. See the [Browser Development Cycle](browser-dev-loop.en.md) for launch steps, budget, and current verification status.

<a id="验证"></a>
## Verification

Node contract includes bundle pin/closure revalidation, two packs reusing one runtime, errors and old generation, output parent symlink, existing target retention, over-limit input, and still use capture bytes when modifying the original input at the beginning of the validator. Rust contract verification does not compile the native engine but can still produce pack, V8 pre-rejection, source token, modern/raw without receipt modification and cleaning. Real producer reuse also records the exact source and does not treat synthetic WASM contracts as evidence of real builds, browsers, GPUs, watches, or devices.
