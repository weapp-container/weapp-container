# Weapp Container

基于 Rust、QuickJS 和 Skia 的跨平台小程序容器。将微信小程序产物转换为 portable manifest / IR，在 Web 或原生宿主中运行，并通过固定版本的微信开发者工具观察兼容行为。

项目处于开发阶段，目前不承诺微信完整兼容或所有平台均可发布。详见[能力矩阵](docs/capability-matrix.md)和[兼容验证说明](docs/conformance/README.md)。

[在线示例](https://container.weapp.dev) · [架构](docs/architecture.md) · [模拟器](docs/simulator.md) · [SDK](docs/sdk-repositories.md) · [贡献指南](CONTRIBUTING.md)

## 从源码开始

需要 Git、Node.js **24.18+ / 24.x**、pnpm **10.15.1**、Rust stable 和宿主 C/C++ 工具链。首次构建需要下载公开的 Rust、QuickJS 和 Skia 依赖；macOS 使用 Xcode Command Line Tools。平台构建细节见 [Rust 构建说明](docs/rust-build-cache.md)。

```sh
git clone --recurse-submodules https://github.com/weapp-container/weapp-container.git
cd weapp-container
corepack enable
pnpm install --frozen-lockfile
pnpm submodule:verify
pnpm container:pack -- fixtures/reference-app --out artifacts/reference
cargo run --locked -p container-simulator -- run --pack artifacts/reference \
  --trace artifacts/simulator/trace.json \
  --snapshot artifacts/simulator/snapshot.json \
  --report artifacts/simulator/report.json
```

此路径从当前源码构建运行时，不需要私有运行库或下载 token。开发态示例还需要准备固定版本的上游构建器：

```sh
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite build:pkgs
pnpm simulator:dev -- --project examples/apps/reference-app --surface web --software
```

默认服务地址为 `127.0.0.1:5179`。CanvasKit、浏览器 Worker、桌面窗口和设备联调的额外准备见[模拟器文档](docs/simulator.md)。

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

## 许可与历史

自有源码采用 **Apache-2.0**。`container-core`、`container-ir` 和 `container-bridge` 保留 **MIT OR Apache-2.0**，第三方组件保留各自许可。新构建携带 `RUNTIME-LICENSE` 和依赖 notices，详见[许可说明](docs/licensing.md)及 [NOTICE](NOTICE)。

公开 Git 从整理后的源码快照开始，原开发历史和大型构建证据保存在私有归档。必要回归 fixture 保留在源码中，详见[历史证据说明](docs/archived-evidence.md)。
