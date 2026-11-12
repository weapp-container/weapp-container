<a id="mpcore--devtools-conformance"></a>
# mpcore / DevTools 兼容性

**简体中文** · [English](mpcore-conformance.en.md)


`scripts/verify-mpcore-conformance.mjs` 是容器仓库的串行 headless conformance 入口。它固定使用 `vendor/weapp-vite` 的 pinned commit，先构建上游 package，再依次执行静态 IDE 启动复用检查、mpcore headless provider smoke 和 Wevu runtime suite。每一步的命令、退出码、耗时和输出都会写入 `artifacts/mpcore-conformance.json`。

<a id="runtime"></a>
## 运行

安全的计划检查不会启动构建或运行时：

```bash
pnpm run mpcore:conformance
```

完整的本地/CI 检查按固定顺序执行：

```bash
pnpm run mpcore:conformance:run
```

已有 `vendor/weapp-vite/node_modules` 和 `dist` 时，可以跳过准备步骤：

```bash
node scripts/verify-mpcore-conformance.mjs --run --skip-prepare
```

suite 结构如下：

| suite | 上游入口 | 覆盖 |
| --- | --- | --- |
| `ide-shared-launch-check` | `scripts/check-e2e-ide-shared-launch.ts` | 检查 IDE 场景只建立一次 `e2e-app` automator，并使用 `miniProgram.reLaunch(route)` 切页 |
| `headless-provider-smoke` | `e2e/ci/headless-automator-provider.test.ts` | headless session 启动、路由、事件和批量数据状态 |
| `wevu-runtime-weapp` | `e2e/ide/wevu-runtime.weapp.test.ts` | ESM/CJS、全部页面 WXML 快照、scroll 和 layout；同一 describe 内复用 session |

这条入口显式设置 `WEAPP_VITE_E2E_RUNTIME_PROVIDER=headless`，所以报告中的 `simulator.status=passed` 只表示 `@mpcore/simulator` headless 语义通过。它不会把结果写成真实微信开发者工具、桌面 GPU、模拟器或真机通过。

<a id="real-devtools-gatekeeping"></a>
## 真实 DevTools 门禁

真实 IDE 必须单独运行上游 DevTools 配置，并显式设置 `WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH`。启动前要使用官方稳定版下载渠道核对安装和版本，并记录实际 Tool 版本、基础库版本、查询时间和资源清理证据。官方渠道来源为 [微信开发者工具下载页](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。

当前容器仓库的 headless 报告会将 `environment.devtools.status` 记录为 `not-run`，并把 `officialStableQueriedAt` 留空；这表示该报告没有把 DevTools 版本核对或真实 IDE suite 混入 headless 结果。目标行为基线仍是用户指定的微信开发者工具 `2.02.2608080`，但只有真实 CLI/窗口/基础库回执才能将该门禁标为通过。

所有真实 IDE suite 继续遵守上游的机器级串行 lease、单窗口、共享 automator 和幂等清理规则。启动失败、未登录、缺少 CLI 或版本无法核对都应在报告中标为 blocked，而不能回退到 headless 并宣称 IDE 通过。

<a id="native-real-ide-observation-2026-10-17"></a>
## 本机真实 IDE 观察（2026-10-17）

本轮预检发现本机安装了 `/Applications/wechatwebdevtools.app`，并通过显式 CLI 选择完成稳定版核对：安装版本与官方稳定版均为 `2.02.2608080`，基础库回执为 `3.17.3`。本轮官方版本查询时间为 `2026-10-17T16:37:11.296Z`、`2026-10-17T16:40:31.237Z` 和 `2026-10-17T16:42:38.562Z`，来源均为 `https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json`。

随后串行重跑了两个最小真实 IDE 场景。`issue-1074-doctor.runtime.test.ts` 能建立 bridge、连接窗口、取得上述版本回执并完成页面 warmup，但最终 `wv doctor --runtime --runtime-port <session-port>` 报告 `project-connection=connection-failed`，所以原 suite 仍失败。根因已通过临时未提交复验隔离：该 fixture 的 `launchAutomator` bridge 回调只暴露 websocket 端口，没有调用 `persistOpenedAutomatorSession` 写入 installation-bound sessionStore；`doctor` 的 `connectOpenedAutomator` 只接受该登记记录。临时在 `onSessionMetadata` 调用该公开 API 后，doctor 退出码为 0、路由为 `isolated/index`，所有请求的 runtime checks 为 complete；这证明是上游测试 harness 的会话登记缺口，而不是容器运行时通过证据。

`issue-969-launch.runtime.test.ts` 在同一官方安装和基础库上本轮通过：bridge/warmup 到 `/pages/login/index`，`loads=[home,login]`、`launchCalls=1`、生命周期含 `redirect:complete`，后续 `/pages/home/index` 导航成功，DOM checkpoints 2/2。此前记录的 `simulator launch failed` 本轮未复现，保留为历史宿主故障证据。两条结果都不能替代完整容器真实 IDE 门禁；每轮测试后受管 DevTools 窗口和 automator 进程均已清理。
