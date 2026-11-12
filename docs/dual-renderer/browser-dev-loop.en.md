<a id="浏览器开发循环"></a>
# Browser Development Loop

[简体中文](browser-dev-loop.md) · **English**


Normal `weapp-simulator dev --web-runtime browser` and `serve_browser_dev` example
Now reuse the same runner: real fixed `weapp-vite` watch, portable pack, managed stage,
the same `BrowserDevOwner` with browser development UI. Currently explicitly supports **browser QuickJS Worker + DOM/WebView or CanvasKit/Skia**, using regular CLI to explicitly select renderer.

Default `auto + remote` retains the original behavior. Browser mode must explicitly select `web + quickjs + webview|skia`, and `auto` will not be silently mapped to renderer; owner takeover or endpoint recovery is not provided. Skia must use a standalone fixed CanvasKit Worker producer; WebView can use either software or CanvasKit producer, with CanvasKit dependency itself not proving actual GPU submission. CLI's `--open` can open the default browser after the original owner and authentication UI configuration is complete; successful listening does not imply Worker or display readiness.

<a id="实施与重验状态"></a>
## Implementation and Revalidation of State

Browser Skia CLI and bounded submission state panel have been integrated; existing DOM/CanvasKit dual-path recordings are available at
[Dual-path execution evidence](../archived-evidence.en.md). The following early DOM recordings
only verify the respective source code bindings and attempts. New features such as selector, button, context recovery, and integration validation must retain their original execution results and cannot reuse previous passes; hardware and performance remain separately verified, and the frozen 279 release gates have not changed accordingly.

Next [controls integration r6](../archived-evidence.en.md)
Completed query, native Button, and Skia recovery full real development cycles on `4f753cab`, all passing.
Query has 15 sets of raw observations and independent geometric/measured stage level validation, Button has 11 interaction checks;
Each set includes 12 hot reloads, interaction retention on build failure, and UI Stop resource cleanup. Historical failures and results from different codebases are separately retained. SwiftShader and full lifecycle synchronous calls are not hidden or treated as hardware performance passes.

The final `smoke-r1` for normal CLI has passed real fixed compiler, QuickJS Worker/DOM, and 12 consecutive WXML hot reloads. The service uses a CLI built without the native engine feature; all 13 generations were verified. The second route `pages/home/index`, initial `count: 7`, independent marker, Worker viewport, and actual iframe geometry of `414×736`, incremented to `8` upon click, returned to `7` after full reload. Compilation failure retains the last interaction; after Stop, all 13 Workers were actually closed and terminated, the original service exit code was `0`, and all self-owned pages, context, and browser were fully closed. Normal high-water level is `78`, retired cursor is `72`, actual retirement requests are 23. Source code, no-native CLI build, and per-generation evidence can be found at [Normal CLI Verification Archive](../archived-evidence.en.md).

The previous experiment entry `retirement-smoke-r2` passed through an eight-step flow involving a real fixed compiler, QuickJS Worker/DOM input, 12 consecutive WXML hot updates, retaining old instances on compilation failure, and UI Stop exit. Normal serial count reached 78, with retirement cursor reaching 72; during long-loop sampling, only 6 normal records and 1,590,840 bytes were retained. 23 real retirement requests were completed, and all 13 actual Dedicated Workers observed shutdown, with original owner, ledger ACK, and HTTP drain completed, and all self-owned pages, contexts, browsers, and services exited. Execution records, screenshots, source code, and binary bindings are available at [retirement and long-loop evidence](../archived-evidence.en.md).

The previous seven-step baseline `smoke-r5` and all its earlier history remain unchanged, see
[Development cycle baseline evidence](../archived-evidence.en.md).
This long cycle r1 previously failed at Stop due to unsettled manager ACK; after the fix, r2 was revalidated, and the original failure was not covered or upgraded. Normal INFO diagnostics will not appear as `ERR_ENGINE`.

In early r3, the packer retained `button` text, nested bindings, and events, but at that time the DOM `button` adapter was still unsupported, resulting in presentation failure after runtime readiness; the original failure and cleanup results were preserved.
The current source code now includes a restricted native DOM button adapter and a dedicated fixture, supporting text, appearance, disabled state, loading state, focus, and native click/keyboard activation. Complex combinations are explicitly rejected. The dedicated execution is verified independently based on its original report; old `view + bindtap` records cannot validate this adapter and do not grant full WeChat button, hybrid component, or frozen list passes.

<a id="启动"></a>
## Startup

First complete [Fixed compiler and managed source preparation](browser-source-preparation.en.md), and independently select pins from the completed Worker producer execution records. The project must be a original mini-program engineering project supported by the managed profile; modern View `container.config.json` projects are not accepted.

From the repository root directory using a regular CLI:

```sh
cargo run --release -p container-simulator -- \
  dev --project /absolute/raw-mini-program-project \
  --surface web --engine quickjs --renderer webview --web-runtime browser \
  --browser-runtime-dir /absolute/completed-worker-producer \
  --browser-runtime-pins /absolute/independent-pins.json \
  --node-bin /absolute/node --port 0 \
  --route pages/home/index --data-json '{"count":7}' --viewport 414x736 --open
```

CLI supports optional initial route, object data, and integer logical viewport dimensions, each side ranging from `1..4096`, defaulting to `375×667`.
These values are strictly validated by the original startup decoder and bound to an immutable intent, and the original supervisor also uses the same values for packaging;
missing routes fall back to the original portable report and report `ROUTE_FALLBACK`, without marking valid packs as build failures.
Browser Worker contains QuickJS, so the entrypoint does not require native QuickJS features.

Skia uses the same CLI and supervisor, replaces the renderer, and provides an independent CanvasKit producer/pins:

```sh
cargo run --release -p container-simulator -- \
  dev --project /absolute/raw-mini-program-project \
  --surface web --engine quickjs --renderer skia --web-runtime browser \
  --browser-runtime-dir /absolute/completed-canvaskit-worker-producer \
  --browser-runtime-pins /absolute/independent-canvaskit-pins.json \
  --node-bin /absolute/node --port 0 --open
```

Browser mode does not read remote's `.weapp-container/presentation.json`. Skia support
`--render-scale auto|1|1.5|2|3|4`, default auto reads screen density from active preview with running instance, creates target based on actual DPR, and explicitly fails when pixel budget is exceeded;
WebView uses browser density, explicit `--render-scale` will be rejected.
The scaling factor only affects physical target, does not alter logical viewport, simulated device `pixelRatio`, or View/WXS evaluation count.
The first presentable frame already includes the native target after scaling; 375×667@2× becomes 750×1334, and stretching old pixels to replace is prohibited.
Targets exceeding 4096 in any side length or 16 MiB RGBA budget explicitly fail; during runtime, switching via owner's `setRenderScale` retains the old target, layout, and session. auto is parsed at owner startup, dynamically updates across screens, and Browser development settings panel is not yet integrated. The Node contract here does not represent actual browser pixel or performance acceptance.

auto Samples only once during the pre-check phase before preview replacement, using a strict internal `captured-auto` 1.0 profile passed to the new owner; screen density values such as 1.25, 1.75 are retained as-is, truncated if below 1× or above 2×.
This internal profile does not belong to the public JSON syntax of CLI/startup, and public values remain restricted to the aforementioned fixed tiers.
Before replacement, in addition to byte pin validation, the producer's owner/Worker render-scale 1.0 ABI declarations are verified; failures due to missing, outdated, unknown fields, or mismatched budgets occur before the old owner is shut down, though the old owner may still respond to bridge messages.
Worker load must provide an exact protocol receipt, though this receipt only signifies semantic negotiation. The first frame applies the scaling factor after a native View layout, then validates the native target's session, render revision, and actual physical dimensions before export is permitted.
These checks do not equate to the browser having rendered or obtained GPU/pixel acceptance.

Replace follows the boundary of single-instance ownership by first closing the old owner, then starting the new owner. Any producer that has declared an ABI will explicitly fail and be subject to existing owner fencing if it incurs a subsequent actual load/frame violation, error, or lateness; the old JS heap will not be restored after closure, and no rollback to the old session is claimed. Currently rejects `--fps`, `--software`, custom `--wv-bin`, `--renderer-assets` and its environment overrides, `--renderer auto`, V8, desktop/both, and modern View configurations, instead of accepting and then ignoring. Only listens to IPv4 loopback; `--host ::1` is currently rejected. Browser-specific runtime parameters cannot be used in remote mode.

Default CLI output root is `<project>/.weapp-container/dev`, and each time a unique runtime root is allocated by the supervisor. Reports are written to `runs/<runId>/browser-dev-summary.json`. Sequential restarts can reuse the output root and will not overwrite the previous report; do not forcibly restart by deleting the running directory.

Compatible with existing example commands:

```sh
cargo run --release -p container-simulator --example serve_browser_dev -- \
  --project /absolute/mini-program-project \
  --producer-dir /absolute/completed-worker-producer \
  --pins /absolute/independent-pins.json \
  --node-bin /absolute/node \
  --out-dir /absolute/fresh-browser-dev-output \
  --port 0
```

| Parameter | Meaning and Default Values |
| --- | --- |
| `--project PATH` | Required, the actual mini-program source code directory. |
|`--producer-dir PATH`| Required, a standalone Worker producer that has been completed; separated from the project, output, and preparation root.|
| `--pins FILE` | Required, the independent producer pins selected before starting the consumer; JSON limit 16 KiB. |
| `--node-bin PATH` | Optional, default uses `node` via `PATH`; executable must be explicitly fixed during validation. |
| `--out-dir PATH` | Optional, default `<project>/.weapp-container/browser-dev`; the runtime and final report are saved here. |
| `--port U16` | Optional, default `0`, port assigned by system; listens only to `127.0.0.1`. |
|`--duration-seconds N`| optional, `1..86400`; calculated from HTTP start, request stops upon expiry, cannot be forcibly skipped past close barrier.|
| `--help` | Output parameter description. |

The tool workspace is fixed to the root directory of the repository that compiles the entry point, and the compiler must match the fixed version
`vendor/weapp-vite` commit `0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`.
The application directory can be located outside the repository; no alternative upstream compiler is selected for the application.

example Keep the existing WebView startup profile, do not add a new renderer parameter, and still require a new
`--out-dir`. If `serve-browser-dev-summary.json` already exists,
refuse startup to avoid overwriting historical evidence; do not restart by deleting directories that are still in use.

<a id="独立-producer-身份"></a>
## Independent producer identity

pin file structure is as follows. Placeholders must be replaced with the original values from the execution record of an independent producer:

```json
{
  "expected": {
    "reportSha256": "<原 build-report.json 字节的 SHA-256>",
    "sourceCommit": "<producer 的 source commit>",
    "sourceSha256": "<producer 的 source inventory SHA-256>",
    "renderer": "software"
  }
}
```

WebView's `renderer` accepts `software` or `canvaskit`; Skia must be `canvaskit` and cannot use software pins for silent fallback. The above example uses software; Skia must be replaced with an independent CanvasKit producer. The full set of pins in the record must be updated, not just the renderer field. Producer authentication does not equal GPU acceptance. `sourceSha256` must use the producer's inventory recipe and cannot be substituted with the file hash from `source-snapshot.json`, nor can the consumer fill in the expected value from the pending verification directory. An arbitrary directory's self-calculated hash does not prove it originates from an authorized complete producer.

Entry verifies the original producer's reported hash before generating credentials, binding listeners, and creating a supervisor, requiring
`status/buildStatus: passed`, `ready: true`, `execution: worker`, producer renderer to match pins, source to be passed, stable, and clean, and commit/inventory SHA to match independent pins.
Then, the original supervisor freezes a bounded copy and executes existing static closure validation.
The original producer is read-only and re-verifies the original report upon exit. Resources can only be provided via the original owner's allowlist and real body lease; URLs are not interpreted as local file paths. Complete byte and source boundaries are defined in
[runtime artifact contract](browser-dev-artifacts.en.md).

<a id="页面与真实-watch"></a>
## Page and real watch

Runtime preparation and the first portable pack share one 180-second deadline. Standard output then emits one JSON line with `event` set to `listening`, containing `url`, `runId`, `preview`, `producer`, `compileSource`, and `summaryPath`, plus the selected `renderer`, `runtimeLocation: browser`, `engine: quickjs`, and `gpuClaimed: false`. Open one working tab at its actual `url`. Listening confirms HTTP setup only; it does not establish Worker or presentation readiness.

Credentials are generated by a trusted native launcher and only enter the inert bootstrap of the same-origin development UI and the original HTTP client; they do not appear in URLs, stdout, or final reports. Do not copy the page bootstrap, control header, or credentials to other pages.

The same `DevSupervisor` manages a real-source code watcher, a fixed compiler, portable input, and finite stage jobs. The same owner sequentially advances control, resources, source code observation, stage admission, and completion; does not establish a second supervisor, ledger, or AppService during a single hot update. The unique manager for the browser page is responsible for actual Worker construction, startup, presentation, and precise shutdown.

Static stage completes will output `event: "staged"`. It does not equal runtime-ready or presented-ready; page state separately displays Worker, visual, and input states. Automatic observation only reads `observe` and does not consume command serial or final budget. The "check for updates" button on the page triggers the same check; it is not the browser refresh button.

The Skia panel displays the runtime location, renderer, physical dimensions, WebGL2 surface/drive, and submission state separately.
`submitted` is a bounded receipt for a local picture/flush, not yet proven accepted by the runtime; `accepted` requires the receipt to be consistent with the current scheduler proof's Worker, attempt, surface generation, render revision, page, template, and viewport, and the metrics fence must be open. Old or late receipts cannot upgrade the current state, and diagnostic metadata does not grant input privileges; input remains under the real ACK path of the original owner/scheduler. Hardware identity remains `physicalHardware: unknown`, and GPU completion status remains `gpuCompletion: not-waited`. Ordinary submissions do not rely on synchronous proof of completion such as `gl.finish()`, and WebGL2 context and `accepted` cannot substitute for physical hardware, screen presentation, or performance evidence.

Optional input diagnostics negotiation, per-input causal recording, and explicit missing presentation endpoints are described in
[Input Causal Diagnostics](input-causal-diagnostics.en.md). This interface always prevents performance conclusions; clone, GPU submit, canvas swap, and runtime ACK are recorded separately and not aggregated into screen presentation.

Source code changes cause previously captured stage to become invalid, and `Unauthorized`, `Stale`, or `Busy` are retained for diagnosis,
waiting for the next-generation product or uncompleted conversion from the original owner. Build diagnostics do not claim success and do not release the original execution instance based on this. Other owners, controls, storage, or HTTP errors enter the stop and original owner cleanup flow.

<a id="停止与资源归属"></a>
## Stop and Resource Ownership

Click the "Stop session" button on the page first, and keep the tab open, waiting for the page to explicitly display `closed`.
When closure fails, retain the original page and session; do not refresh the page or create a new manager. Only show "Retry cleanup" if the actual owner has closed, but ACK or transport cleanup fails; it cannot convert an unfinished Worker close into a success.
Ctrl-C or expiration of `--duration-seconds` will also request a stop; the server continues to provide the original authentication control endpoint, allowing the same browser manager to complete the actual cleanup.

Stopping requires separately crossing the following barriers:

1. The original manager waits for its real Worker, loading, presenter, bridge, mount, and transmission work to close;
   The corresponding receipt must match the original registered identity and close ticket.
2. If `try_shutdown()` returns `true` for the same owner, it proves that the original process, stage, and resource borrowing have reached the existing cleanup contract. `false` or error retains the original owner and cannot be considered complete.
3. The closure check of the original ledger confirms there are no pending, uncertain, or unACKed final operations; after the real HTTP queue is emptied, admission is stopped and the original socket drain is confirmed.

Idle waiting, socket disconnection, and HTTP 200 responses are all insufficient to replace the barrier described above. This entry explicitly enables the browser-reported close policy: the server associates the original receipt with a trusted manager, yet still does not treat this report as conclusive evidence of independent observation of Worker termination or browser transport.close. Specific contract controls are detailed in [HTTP Control and ACK](browser-control-http.en.md).

Page force-refresh, crash, loss, or direct closure results in the new page unable to recover the original manager, its actual Worker, or the closure barrier. Entry has no takeover or automatic release upon disconnection. At this point, the original owner and service may remain active, waiting for explicit evidence of original cleanup; recovery cannot be achieved by re-binding ports, replaying new mutations, swapping the owner, or forging a `never-constructed` receipt to claim successful cleanup.

<a id="有界记录与显式回收"></a>
## Bounded Records and Explicit Recycling

The experiment entrypoint enables both the original owner, bootstrap, and client `retirementVersion: "1.0"` at startup time.
The default library entrypoint remains disabled; HTTP request-based upgrade capability is not available. Prior to each update check, the original manager performs bounded progression of ACK and retirement work, even if the product has not changed or compilation has failed. Recycling applies only to the earliest prefix where final acceptance has been received, a true ACK has been received, and all original invoke/replay/ACK and transaction work has been settled.

The default byte budget for normal is still 16 MiB, reserving up to the maximum final cost for each initial command, typically
able to **retain 60 normal control commands simultaneously**, not 60 updates. Upon successful retirement, the original record capacity is restored; serial and permanent high-water marks are not reset, and old IDs and unseen IDs below the high-water mark are permanently rejected.
The manager can independently release local reservations that have been terminated and never transmitted, without faking a server-side final, ACK, or retirement.

Each lane retains at most one pending retirement transaction, composed of 1–64 actual records forming a prefix, allowing for gaps in uncommitted digits. On receipt loss, retry the same digest/cursor; no skipping of pending transactions is allowed. The server retains per lane only the most recent exact receipt and permanent cursor; the client must first complete cleanup of the original reader/hash/abort relay before releasing records. Protocol, summary recipe, and individual budgets are detailed in [HTTP Control and Retirement](browser-control-http.en.md).

This removes the lifetime limit of "about 60 normal commands can be accumulated per run," but does not guarantee infinite reliable operation. Unacknowledged, conflicting, or unresponsive work or retirement failures can still block prefixes and exhaust retention budgets; the `u64` serial upper limit remains explicitly rejected. Cleanup, recovery, ACK, and retirement work each have independent budgets. On stop, priority is given to closing the original Worker/owner, waiting for ongoing retirement work to complete, and no new retirement requests are issued after Stop; retirement failures retain their failure state, neither hindering the necessary actual shutdown nor falsely claiming successful receipts. The Stop ACK check simultaneously waits for both HTTP actual work and the manager's `drainControlWork()` state settlement barrier; network completion does not equate to the manager having adopted the result.

Real long-loop runner can explicitly pass `--reloads 12`; it requires normal serial to exceed 64, the presence of a real retirement request and a successful cursor, and then validates compilation failure retention, actual Worker generation-level shutdown, and original service exit.
`retirement-smoke-r2` has completed the above eight steps, with results independently archived, not overriding the prior conclusions from the first seven steps r5.

<a id="报告与待验证范围"></a>
## Reports and Scope Pending Verification

Only after the gate is closed does the entry write `summaryPath` and output `event: "shutdown"`.
The report records the exit results for the same owner, the original ledger cleanup status, HTTP socket drain, producer
report validation, compiler and source code binding, and actual observed runtime/presentation receipts.
These historical receipts do not indicate that the current frame is still running.

The existence of a user-owned directory is checked against the ownership record from the original supervisor and the actual portable path;
The ownership record in the output root is retained as evidence and will not be deleted for the entire output directory specified by the user.
The currently public owner API does not provide watcher PID or final process exit status, thus the missing components are explicitly annotated and cannot be filled in with fabricated PIDs or exit codes.

| Verification Item | Current Status |
| --- | --- |
| Real browser bootstrap, Worker first frame and input | Regular CLI final r5 DOM and CanvasKit pass, using real QuickJS WASM Worker. |
| Real watch, failure retention, and bounded retirement | Both r5 paths pass, each performing 12 updates and 13 different Workers, and compilation failure still retains the old instance interaction. |
| ACK, Original Owner Exit, and Self-Directory Cleanup | Both r5 paths pass; original service exit code is 0, self-owned page/context/browser has been closed, no retained test service. |
| Test commands, environment, source code hash, and execution records | Final 690 file range unchanged; simulator 543 passed, 7 skipped, no native CLI passed (7 passed), Worker contract 767 passed; other results see archive. |

Format validation and all target/feature strict workspace Clippy checks passed; browser results come from actual r5
Report, not derived from compilation or source code inspection. Full record available at [Ordinary CLI Dual-Path Evidence](../archived-evidence.en.md);
Previously [retirement r2](../archived-evidence.en.md) retained its historical source code and conclusions.
Final CanvasKit uses SwiftShader, and active owner observed no synchronization read-back or
`finish` for contexts prior to retirement; global 15 retirement synchronizations and original call stacks are fully preserved. This limited scope of inspection does not prove that hot reload destruction did not wait, nor does it prove physical GPU or GPU completion.

This page and the entry code itself do not improve GPU performance, CanvasKit performance, input latency, WeChat DevTools oracle, performance with other hosts, official emulators, or real devices, nor do they achieve the seven-host goal or meet the WeChat near-parity gate.
The 279 frozen release gates remain unknown; limited real execution of Skia CLI has been documented above, performance has not yet been accepted, modern View development configurations and hard refresh takeover remain unavailable; bounded retirement does not provide infinite reliability guarantees.

<a id="dom-smoke-的当前画面与退休证据"></a>
## Current View of DOM smoke and Retirement Evidence

DOM presenter allows multiple iframes to coexist during preparation, submission, and cleanup of the previous generation.
Candidate and retired frames remain inert; harness can select only one non-inert, visible, connected to the top-level document, and pointer-input-enabled frame from the current own session mount. Zero input frames indicates waiting, while multiple input frames results in direct failure. Title matching is used solely for audit of all candidates and cannot use first/nth to substitute for input authority.

Current sampling simultaneously associates the real Worker's `view.prepare` scheduling, the enabled `view.presented` final with the same key, and the latest runtime's page, viewport, template revision, and surface generation. View metadata preparation only projects the key and consumed input, without recording ViewDocument. Such records are labeled `observed-dom-final`, which are observations from testing; a one-time startup of `accepted-proof` in manager history is not considered a new proof on each render, and the harness does not write runtime authority.

After the old iframe is removed, the saved child nodes might still have the old srcdoc Document as root, thus their `isConnected` remains true. The held Space test preserves this original fact, verifying that the actual owning iframe detaches from the top-level, Document/Element source, new and old focus identities, and the old Document has no focus, and verifying that the real late keyup does not replay a click, the AppService state does not change, and subsequently the new Space generates only one tap. The native audit continues to observe all candidates and the old document, without filtering audit sources by the current surface.

In the compilation failure report, `retainedAppCount` comes from actual AppService observations; worker count is still calculated by independent constructor/terminate records. The fields and failure results from the old report remain unchanged.
These harness boundary tests do not replace re-running real browser, device, or performance gates.
