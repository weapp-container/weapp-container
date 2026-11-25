# Weapp Container

**简体中文** · [English](README.en.md)

独立的开源便携运行时，用于在受控进程中加载小程序格式的页面、组件、脚本和样式，也支持以独立 Canvas、定时器和平台无关事件桥接运行未加密小游戏包。项目提供 manifest 打包器、Rust 运行时、QuickJS/V8 执行引擎、模拟器以及 Node 测试绑定。

本项目与任何第三方平台、品牌、服务或 SDK 没有隶属、授权或商业合作关系。仓库只提供便携运行时、清单格式和兼容性接口名称，不包含官方工具、原生平台 SDK、账户系统或外部服务桥接。所有外部权限与网络能力都由调用方自行实现。

## 快速开始

```sh
pnpm install
pnpm container:manifest:test
pnpm conformance:verify
pnpm api:inventory:verify
```

Node 绑定只消费源码目录或已生成的 portable pack。编译器、宿主服务和外部网络由调用方自行选择和管理。

## Native SDK 示例与发行状态

Android、iOS、React Native、Flutter 与 Desktop 的 reference consumer 位于 `sdk/` 子模块中，包含 pack 加载、会话、视图、消息、导航、存储和生命周期用法。公开注册源当前提供 `0.1.0-preview.7.1` 预览包，尚无稳定版本。各平台安装状态、限制和示例运行步骤见[SDK 发行状态](docs/public-sdk-release.md)、[源码构建指南](docs/sdk-source-build.md)及各 SDK README。

- [Android 示例应用](sdk/android/consumer/README.md)
- [iOS UIKit 示例应用](sdk/ios/examples/consumer/README.md)
- [React Native 示例应用](sdk/react-native/example/README.md)
- [Flutter 示例应用](sdk/flutter/example/README.md)
- [Desktop 消费示例](sdk/desktop/consumer/README.md)
- [Contract C ABI 宿主示例](sdk/contract/examples/consumer/README.md)

## DevTools 下载预览

桌面 DevTools 安装包包含固定版本的 Node.js、weapp-vite 编译器、manifest packer 和模拟器。安装后选择项目目录，工具会先检查 `project.config.json`、源 `app.json`、编译器兼容矩阵和项目依赖，再启动 Web Player 或 Desktop Player。当前生产样本为 `examples/apps/community/official-text`、`ant-design-button`、`taro-blended` 和 `examples/apps/shop-demo`。

发行包中的 `weapp-devtools.json` 记录源码、编译器、Node、兼容矩阵和文件哈希。稳定版使用签名更新清单，macOS 安装包使用 Developer ID 签名并完成公证，Windows MSI 使用 Authenticode 签名。缺少稳定版签名材料时发布工作流会在发布前失败。预览版不会自动参与稳定更新。发行签名、平台安装和官方工具证据按平台单独记录，不能由本地 headless 检查替代。

## 小游戏

使用 `--game` 打包未加密、已解包的小游戏产物，并通过 QuickJS simulator 启动：

```sh
pnpm container:pack -- ./game-dist --game --out ./artifacts/game
cargo run -p container-simulator --features quickjs-native -- \
  run --pack ./artifacts/game --snapshot ./artifacts/game/snapshot.json
```

运行时提供 Canvas 2D 子集和 requestAnimationFrame。宿主通过平台无关的 `game.event` 提交规范化触摸、键盘、传感器、音频中断和内存告警事件。显示/隐藏沿用 `app.lifecycle`，viewport 更新会调整游戏 Canvas 并通知 `wx.onWindowResize`。事件载荷见 [game-event-v1.schema.json](schemas/game-event-v1.schema.json)。小游戏 API 仍按清单和宿主能力协商，官方 DevTools、GPU 与设备一致性尚未验证。

## 开源小程序示例

`examples/apps/community/` 收录了微信官方文本页、Ant Design Mini 按钮组件和 Taro blended-basic 页面三个经过整理的可运行快照。每个样例保留上游 MIT 许可证，并在目录说明与 `SOURCES.json` 中记录仓库、固定提交和本地调整。

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/community/official-text" -p weapp \
  --outDir "$PWD/artifacts/community/official-text/raw"
pnpm container:pack -- artifacts/community/official-text/raw \
  --out artifacts/community/official-text/pack \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
pnpm simulator:dev:smoke -- \
  --project examples/apps/community/official-text
```

另外两个样例将命令中的 `official-text` 分别替换为 `ant-design-button` 和 `taro-blended`。样例列表、逐项命令和来源见 [`examples/apps/community/README.md`](examples/apps/community/README.md)。

在浏览器中保持模拟器运行：

```sh
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/community/official-text --surface web
```

## 许可证

Apache-2.0。请阅读 [NOTICE](NOTICE) 和 [SECURITY.md](SECURITY.md)。
