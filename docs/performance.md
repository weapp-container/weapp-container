# 性能证据与门槛

性能门槛分为协议层和宿主层。`scripts/perf-baseline.mjs` 在所有 CI runner 上执行可重复的协议层基准：1000 节点参考应用元数据、10000 项批量 `setData`、批量 bridge envelope，并将提交 SHA、引擎、宿主和运行环境写入 `performance-report-v1` 报告。`scripts/check-performance-report.mjs` 会强制执行以下可测门槛：

- 10000 项 `setData` 的 p95 ≤ 8 ms；
- bridge p99 ≤ 2 ms（Web/桌面）或 ≤ 5 ms（Android/iOS/鸿蒙）。

冷启动、首帧、长列表丢帧率、稳态内存和 QuickJS 包体必须由宿主 harness 写入同一个 schema 的 `metrics`。当前通用 Node 基准将这些值标记为 `not_measured`，报告状态为 `incomplete`；这不会被当作宿主或设备通过。宿主 harness 完成全部指标后使用 `--require-complete` 执行 checker，只有所有指标为 `measured` 且满足阈值时才会接受 `status: passed`。

运行协议基准并检查：

```bash
pnpm perf:baseline -- --out artifacts/performance-report.json
pnpm perf:check artifacts/performance-report.json
```

在安装了原生 Skia bundle（或 Python/Clang/Ninja 源码构建工具链）的机器上，运行
host renderer probe。它会把 Rust/Skia 的 1000 节点提交、首帧、滚动帧预算和进程
RSS 合并到同一个 schema，并可使用完整门禁检查：

```bash
pnpm perf:native -- --iterations 60 --out artifacts/native-performance-report.json
pnpm perf:check artifacts/native-performance-report.json --require-complete
```

`native-performance-report.json` 的 `nativeHost: passed` 只表示 probe 确实使用了
`backend: "skia-gpu-*"` 并满足当前构建机器的门槛。当前 `skia-backend` 只产生
`skia-raster` CPU 离屏读回，因此不会进入 native/GPU 性能证据；报告不宣称任何
移动设备或 GPU 驱动通过。

固定发布矩阵包含七个宿主（Web、macOS、Windows、Linux、Android、iOS、鸿蒙）和两种
引擎（QuickJS、V8）。可以一次生成 14 个可审计的报告和 `index.json`：

```bash
pnpm perf:matrix -- --iterations 30 --allow-incomplete --out-dir artifacts/performance-matrix
```

矩阵命令会为每个宿主/引擎运行协议基准，并把没有宿主生命周期、渲染帧时钟、内存
采样器或设备/GPU harness 的行标记为 `availability: "unavailable"`。这一步只生成证据
缺口，不能把编译成功、模拟器可连接或 software fallback 升级为通过。将某一行升级为
`available` 需要对应宿主 harness 写入完整冷/热启动、首帧、滚动、RSS 和包体数据，随后
执行 `pnpm perf:check <report> --require-complete`。矩阵未全部完成时命令默认以非零退出；
`--allow-incomplete` 仅用于保存当前缺口报告。

开发机可以额外传入一个已经打包的参考应用，让矩阵为 Web 和桌面四个 surface
（Web、macOS、Windows、Linux）各运行 QuickJS/V8 simulator probe：

```bash
pnpm perf:matrix -- \
  --pack artifacts/reference \
  --iterations 20 --allow-incomplete \
  --out-dir artifacts/performance-matrix
```

该模式会为两种引擎分别建立隔离的 Cargo target 目录。Web 行同时构建并运行
`web-host-perf`，让 `Simulator` 和 `WebSurface` 在同一进程中测量宿主进程冷启动、
runtime snapshot 首帧、生命周期状态、HTTP bridge、峰值 RSS 和 snapshot 元数据；
macOS/Windows/Linux 行继续重复启动 `weapp-simulator run` 做软件进程探针。所有行都复用
同一份 10000 项 `setData` 协议基准。这些字段位于报告的可选 `hostProbe` 中，便于定位
回归；Web host probe 的证据可用性为 `availability: "available"`，但仍保持
`status: "incomplete"`，因为它没有浏览器 CanvasKit、桌面窗口或 GPU frame sampler。
macOS/Windows/Linux 进程探针继续保持 `availability: "blocked"`，移动行继续保持
`availability: "unavailable"`。只有实际宿主接入生命周期、GPU/帧时钟、RSS 和完整引擎
harness 后，才能将行升级为 `available` 并通过 `--require-complete`。

`hostProbe.mode: "simulator-process"` 的进程和 snapshot 数值是开发态运行时证据，不能
被解释为原生窗口、CanvasKit、Skia GPU、模拟器或真机性能。性能 checker 会拒绝该模式
宣称 `nativeSurfaceAttached` 或 `gpuFrameSamplerAttached`，避免复制报告时丢失证据边界。

报告 schema 位于 [`schemas/performance-report-v1.schema.json`](../schemas/performance-report-v1.schema.json)，矩阵索引 schema 位于
[`schemas/performance-matrix-v1.schema.json`](../schemas/performance-matrix-v1.schema.json)。每次性能回归应保存 JSON artifact，并保留 `commit`、`host`、`engine` 与 `environment`（包括平台、架构、分支和工作树是否干净），以便区分代码变化、宿主差异和测量环境变化。

运行 `pnpm near-parity:gates` 时，性能 gate 会按当前 `HEAD` 选择矩阵：优先使用
commit 完全匹配的索引，否则从 `artifacts/performance-*` 和已提交的
`docs/performance-evidence/*/matrix/index.json` 中按 `generatedAt` 选择最新记录，并在
`performanceDiscovery` 中记录候选、选择原因和 commit 是否匹配。已提交的证据索引如果
仍指向被忽略的 `artifacts` 目录，gate 会优先读取同一 `matrix/` 目录中的跟踪副本，保证
在新 checkout 中可复现。对于本地 `perf:matrix --out-dir <dir>` 生成的 `<dir>/index.json`
也会被发现，避免当前提交的矩阵被旧的 conventional `artifacts/performance-matrix-current`
索引遮蔽。聚合前，所有声称 `status: "passed"` 的报告还会重新经过
`perf:check --require-complete` 的 schema、metric、阈值和 native evidence 校验；没有当前
commit 的记录，或记录只有 software/protocol/blocked 证据时，性能 gate 仍为 `incomplete`；
这些状态不会被自动升级。需要审阅某个固定索引时可
显式传入 `--performance-index <path>`，需要固定报告文件时可重复传入 `--performance <path>`。

API inventory 也有独立的 canonical golden 校验：

```bash
pnpm api:inventory:verify
```

该命令检查七类宿主、两种引擎、每个 API 的覆盖项和 conformance 编号，并比对 `docs/api-inventory-v1.sha256`。修改 inventory 时必须同时更新 golden hash，并在 CI 中重新审阅能力变化。
