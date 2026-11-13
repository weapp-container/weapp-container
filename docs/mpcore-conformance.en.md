<a id="mpcore--devtools-兼容性"></a>
# mpcore / DevTools conformance

[简体中文](mpcore-conformance.md) · **English**


`scripts/verify-mpcore-conformance.mjs` is the serial headless conformance entry point for the container repository. It statically uses the pinned commit of `vendor/weapp-vite`, builds the upstream package first, then sequentially executes static IDE startup reuse checks, mpcore headless provider smoke, and Wevu runtime suite. The command, exit code, duration, and output for each step are written to `artifacts/mpcore-conformance.json`.

<a id="运行"></a>
## Runtime

Safe plan checks will not start build or runtime:

```bash
pnpm run mpcore:conformance
```

A complete local/CI check is executed in a fixed order:

```bash
pnpm run mpcore:conformance:run
```

Already have `vendor/weapp-vite/node_modules` and `dist` , you can skip the preparation steps:

```bash
node scripts/verify-mpcore-conformance.mjs --run --skip-prepare
```

suite structure is as follows:

| suite | upstream entry | coverage |
| --- | --- | --- |
| `ide-shared-launch-check` | `scripts/check-e2e-ide-shared-launch.ts` | Check that the IDE scenario establishes the `e2e-app` automator only once and navigates between pages using `miniProgram.reLaunch(route)` |
| `headless-provider-smoke` | `e2e/ci/headless-automator-provider.test.ts` | headless session startup, routing, events, and batch data state |
| `wevu-runtime-weapp` | `e2e/ide/wevu-runtime.weapp.test.ts` | ESM/CJS, snapshot of all pages WXML, scroll and layout; reused session within the same describe |

This entry explicitly sets `WEAPP_VITE_E2E_RUNTIME_PROVIDER=headless`, so the report's `simulator.status=passed` only indicates that the `@mpcore/simulator` headless semantics passed. It does not imply that the result has been written as a real WeChat Developer Tool, desktop GPU, simulator, or real device passing.

<a id="真实-devtools-门禁"></a>
## Real DevTools Gatekeeping

A real IDE must run the upstream DevTools configuration separately and explicitly set `WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH`. Before startup, verify the installation and version via the official stable version download channel, and record the actual Tool version, foundation library version, query time, and evidence of resource cleanup. The official source is available at [WeChat Developer Tool Download Page](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html).

Currently, the headless container repository reports `environment.devtools.status` as `not-run` and leaves `officialStableQueriedAt` empty; this indicates that the report did not verify the DevTools version or genuinely included an IDE suite in the headless result. The target behavior baseline remains the user-specified WeChat Developer Tool version `2.02.2608080`, but only actual CLI/window/base library receipts can mark this gate as passed.

All real IDE suites continue to adhere to the upstream machine-level serial lease, single-window, shared automator, and idempotent cleanup rules. Launch failures, unauthenticated states, missing CLI, or version mismatches should be reported as blocked and must not be reverted to headless mode and claimed as IDE passed.

<a id="本机真实-ide-观察2026-10-17"></a>
## Native Real IDE Observation (2026-10-17)

This pre-check round discovered that `/Applications/wechatwebdevtools.app` is installed on the local machine, and a stable version verification was completed via explicit CLI: the installed version matches the official stable version, both being `2.02.2608080`, with the base library receipt at `3.17.3`. The official version query times for this round are `2026-10-17T16:37:11.296Z`, `2026-10-17T16:40:31.237Z`, and `2026-10-17T16:42:38.562Z`, all sourced from `https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json`.

Then two minimal real IDE scenarios were rerun sequentially. `issue-1074-doctor.runtime.test.ts` could establish the bridge, connect the window, obtain the above-mentioned version receipts, and complete page warmup; however, the final `wv doctor --runtime --runtime-port <session-port>` reported `project-connection=connection-failed`, so the original suite still failed. The root cause has been isolated through a temporary, uncommitted retest: this fixture's `launchAutomator` bridge callback only exposes the WebSocket port and does not invoke `persistOpenedAutomatorSession` to write to the installation-bound sessionStore; the `doctor`'s `connectOpenedAutomator` only accepts this registered record. Temporarily calling this public API in `onSessionMetadata` resulted in a doctor exit code of 0, route of `isolated/index`, and all runtime checks for requests being marked as complete; this proves the gap in session registration in the upstream test harness, not evidence of failure in the container runtime.

`issue-969-launch.runtime.test.ts` Passes this round on the same official installation and foundation library: bridge/warmup to `/pages/login/index`, `loads=[home,login]`, `launchCalls=1`, lifecycle includes `redirect:complete`, subsequent navigation to `/pages/home/index` succeeds, DOM checkpoints 2/2. The previously recorded `simulator launch failed` is not reproduced this round and remains as historical host failure evidence. Neither result can replace the full container real IDE gatekeeping; DevTools windows and automator processes have been cleaned up after each test round.
