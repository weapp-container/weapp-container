<p align="center"><img src="assets/brand/weapp-container-mark.svg" width="96" height="96" alt="Weapp Container" /></p>

# Weapp Container

**简体中文** · [English](README.en.md)


将小程序嵌入自己的应用。Weapp Container 提供 Rust 运行时、portable pack 打包工具、开发模拟器，以及 Android、iOS、C++ Desktop、Flutter 和 React Native 接入层。

[开发文档](https://container.weapp.dev/docs/) · [在线示例](https://container.weapp.dev/demo/) · [源码文档索引](docs/README.md) · [参与贡献](CONTRIBUTING.md)

[GitHub 预发布下载](https://github.com/weapp-container/weapp-container/releases)

[![公共源检查](https://github.com/weapp-container/weapp-container/actions/workflows/public-ci.yml/badge.svg)](https://github.com/weapp-container/weapp-container/actions/workflows/public-ci.yml)

接入从已有的原生小程序目录或框架构建产物开始，不要求使用 weapp-vite。打包工具将输入转换为可校验的 manifest、IR 和内容寻址资源，运行时管理 JavaScript 执行、页面、导航、存储和宿主通信。QuickJS 是主要引擎；V8、Skia 与浏览器呈现路径按配置和宿主能力选择。

当前为 **preview**。源码可公开获取和构建，各平台的可构建、可安装、已运行与已验收状态分别记录；不承诺微信完整兼容。先查看[能力矩阵](docs/capability-matrix.md)、[平台状态](https://container.weapp.dev/docs/platforms/)及[验证方法](docs/conformance/README.md)。

公开预览版 `0.1.0-preview.7.0` 的核心运行库、iOS、Desktop 和 CocoaPods Specs 已提供公开下载。npm、Maven Central 和 pub.dev 尚未全部发布；安装命令、验证范围及阻塞项见[发布状态](docs/public-sdk-release.md)。

<a id="choose-a-starting-point"></a>
## 选择你的入口

| 你要做什么 | 从这里开始 |
| --- | --- |
| 了解运行效果 | [浏览器固定演示](https://container.weapp.dev/demo/)，示例内容为中文，支付与订单为模拟数据 |
| 把小程序放进自己的应用 | [快速开始](https://container.weapp.dev/docs/start/)与[各平台接入指南](https://container.weapp.dev/docs/integrations/) |
| 打包原生小程序或已有构建产物 | [portable pack](https://container.weapp.dev/docs/pack/)与[独立打包工具](tools/container-manifest/README.md) |
| 修改运行时或开发自有宿主 | [架构](docs/architecture.md)、[SDK 合约](https://github.com/weapp-container/sdk-contract/blob/main/README.md)与[工程文档索引](docs/README.md) |
| 研究兼容行为与限制 | [API 记录](docs/api-runtime-conformance.md)、[宿主能力](docs/host-services/README.md)与[conformance](docs/conformance/README.md) |

<a id="build-from-source"></a>
## 从源码开始

需要 Git、Node.js **24.18+ / 24.x**、pnpm **10.15.1**、Rust stable 和宿主 C/C++ 工具链；macOS 使用 Xcode Command Line Tools。下面的无界面路径使用 QuickJS 和软件渲染，不构建 Skia。可视化预览和原生 SDK 还需要下载公开的 Skia 依赖，详见 [Rust 构建说明](docs/rust-build-cache.md)。

```sh
git clone --recurse-submodules https://github.com/weapp-container/weapp-container.git
cd weapp-container
corepack enable
pnpm install --frozen-lockfile
pnpm submodule:verify
pnpm container:pack -- fixtures/reference-app --out artifacts/reference
cargo run --locked -p container-simulator --no-default-features --features quickjs-native -- run --pack artifacts/reference \
  --trace artifacts/simulator/trace.json \
  --snapshot artifacts/simulator/snapshot.json \
  --report artifacts/simulator/report.json
```

此路径使用仓库自带的原生小程序 fixture，从当前源码构建运行时，无需历史运行库、下载 token 或 weapp-vite。输出为 trace、状态快照与执行报告；可视化开发预览见[模拟器](docs/simulator.md)。

<a id="optional-develop-the-weapp-vite-examples"></a>
### 可选：使用 weapp-vite 开发示例

仓库中的部分开发态示例使用固定版本的上游构建器。只有选择这些示例时才需要：

```sh
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite build:pkgs
pnpm simulator:dev -- --project examples/apps/reference-app --surface web --software
```

默认服务地址为 `127.0.0.1:5179`。CanvasKit、浏览器 Worker、桌面窗口和设备联调的额外准备见[模拟器文档](docs/simulator.md)。

<a id="repository-layout-and-integrations"></a>
## 目录与接入

| 部分 | 用途 |
| --- | --- |
| `tools/container-manifest`、`schemas` | 产物校验、manifest、内容寻址资源和 IR |
| `crates/container-runtime` | 会话、生命周期、导航、宿主调用和输入状态 |
| `crates/container-engine-*` | QuickJS 与显式 V8 provider 边界 |
| `crates/container-render-skia`、`container-host-*` | 绘制、Web 与原生宿主适配 |
| `crates/container-simulator`、`apps/dev-player` | 开发模拟器和设备客户端 |
| `sdk/*` | 独立的合约及 Android、iOS、Desktop、Flutter、React Native 包装层 |
| `website` | 文档与展示应用源码 |
| `tools/runtime-artifacts` | [运行库打包、离线验证与发行工具](tools/runtime-artifacts/README.md) |

SDK、Website 和 `vendor/weapp-vite` 通过 submodule 固定提交。修改后应在对应仓库提交，再更新主仓库指针。SDK 的预编译锁文件仍可能指向历史发行物；当前源码接入见 [SDK 构建说明](docs/sdk-repositories.md)。

<a id="checks"></a>
## 检查

```sh
pnpm opensource:check
pnpm docs:check
pnpm naming:check
pnpm naming:test
pnpm container:manifest:test
pnpm sdk:contracts:test
pnpm sdk:test
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
```

PR 基础检查使用公开依赖；完整平台矩阵、官方开发者工具、设备、GPU 和性能验证保留手动入口。单元测试不替代真实工具或硬件结果。

<a id="license-and-history"></a>
## 许可与历史

自有源码采用 **Apache-2.0**。`container-core`、`container-ir` 和 `container-bridge` 保留 **MIT OR Apache-2.0**，第三方组件保留各自许可。新构建携带 `RUNTIME-LICENSE` 和依赖 notices，详见[许可说明](docs/licensing.md)及 [NOTICE](NOTICE)。

公开 Git 从整理后的源码快照开始，原开发历史和大型构建证据保存在私有归档。必要回归 fixture 保留在源码中，详见[历史证据说明](docs/archived-evidence.md)。

旧运行库归档保留其随附许可和固定哈希，部分历史默认下载 pin 当前不可用。源码许可不重新授权旧二进制；当前接入优先[从匹配源码构建](docs/sdk-repositories.md)，历史下载兼容见[迁移说明](docs/runtime-artifacts-migration.md)。
