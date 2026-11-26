# Weapp Container

**简体中文** · [English](README.en.md)

独立的开源便携运行时，用于在受控进程中加载小程序格式的页面、组件、脚本和样式，也支持以独立 Canvas、定时器和平台无关事件桥接运行未加密小游戏包。项目提供 manifest 打包器、Rust 运行时、QuickJS/V8 执行引擎、模拟器以及 Node 测试绑定。

本项目由社区独立开发，与 Tencent/WeChat、Ant Group/Alipay 及其平台、品牌或服务不存在隶属、官方授权、背书或商业合作关系。文中的平台名称、商标与 API 标识仅用于说明兼容目标或上游样例来源，相关权利归各自权利人所有。本仓库另含按随附许可证分发的第三方开源代码。

## 下载使用

直接使用桌面 DevTools：打开[下载页](https://container.weapp.dev/downloads/)，选择适合系统与处理器的安装包，然后在工具中打开已有的小程序项目。也可打开[在线演示](https://container.weapp.dev/)体验固定样例，无需下载项目源码。

在应用中集成时，从对应平台的公开 SDK 包或发行归档开始，见下方[SDK 发行状态](docs/public-sdk-release.md)。

## 仓库开发检查

下面的命令面向维护和贡献者，不是普通应用的安装或预览步骤。

```sh
pnpm install
pnpm container:manifest:test
pnpm conformance:verify
pnpm api:inventory:verify
```

Node 绑定只消费源码目录或已生成的 portable pack。编译器、宿主服务和外部网络由调用方自行选择和管理。

## Native SDK 示例与发行状态

Android、iOS、React Native、Flutter 与 Desktop 的 reference consumer 位于 `sdk/` 子模块中，包含 pack 加载、会话、视图、消息、导航、存储和生命周期用法。公开注册源当前提供 `0.1.0-preview.7.1` 预览包，尚无稳定版本。各平台的普通安装方式、限制和示例运行步骤见[SDK 发行状态](docs/public-sdk-release.md)及各 SDK README。[源码构建指南](docs/sdk-source-build.md)只适用于维护 SDK 或重建发行物。

- [Android 示例应用](sdk/android/consumer/README.md)
- [iOS UIKit 示例应用](sdk/ios/examples/consumer/README.md)
- [React Native 示例应用](sdk/react-native/example/README.md)
- [Flutter 示例应用](sdk/flutter/example/README.md)
- [Desktop 消费示例](sdk/desktop/consumer/README.md)
- [Contract C ABI 宿主示例](sdk/contract/examples/consumer/README.md)

## DevTools 下载预览

桌面 DevTools 安装包包含固定版本的 Node.js、weapp-vite 编译器、manifest packer 和模拟器。安装后选择项目目录，工具会先检查 `project.config.json`、源 `app.json`、编译器兼容矩阵和项目依赖，再启动 Web Player 或 Desktop Player。当前生产样本为 `examples/apps/community/miniprogram-demo-text`、`ant-design-button`、`taro-blended` 和 `examples/apps/shop-demo`。

发行包中的 `weapp-devtools.json` 记录源码、编译器、Node、兼容矩阵和文件哈希。稳定版使用签名更新清单，macOS 安装包使用 Developer ID 签名并完成公证，Windows MSI 使用 Authenticode 签名。缺少稳定版签名材料时发布工作流会在发布前失败。预览版不会自动参与稳定更新。发行签名、平台安装和官方工具证据按平台单独记录，不能由本地 headless 检查替代。

维护者可以用仓库自带的最小项目验证 launcher、项目预检、Web Player 首屏与交互、WXSS 原位重载、JS 重启、构建失败保留和恢复：

```sh
pnpm devtools:loop:smoke
```

报告默认写入 `~/.codex/private-validation/weapp-container/devtools-loop/report.json`。可以用 `--project <dir>` 对其他受支持项目执行预检、启动和首屏检查，完整热重载回归仍使用仓库最小项目。该检查使用本机构建的 simulator 和 headless Chromium，只验证本地 Web 开发链路。官方微信开发者工具基线和真实设备仍需分别通过对应门禁。

### 未签名预览版启动

当前 GitHub prerelease 的 macOS 和 Windows 安装包没有平台签名，首次启动可能显示系统警告。只从对应 GitHub Release 下载，并先用发布页的 `SHA256SUMS` 核对文件哈希。确认来源和哈希后，可以按平台移除下载隔离标记。

macOS 按处理器架构选择对应的 `.dmg`，Apple Silicon 选择 `macos-arm64`，Intel Mac 选择 `macos-x86_64`。打开 DMG，将 `Weapp Container DevTools.app` 拖到 Applications，再执行：

```sh
shasum -a 256 "$HOME/Downloads/weapp-container-devtools-macos-arm64.dmg"
xattr -dr com.apple.quarantine "/Applications/Weapp Container DevTools.app"
open "/Applications/Weapp Container DevTools.app"
```

网站下载页会在浏览器提供可靠架构提示时标记匹配的 DMG。Safari 以及未提供可靠架构提示的浏览器会同时显示两个选项，请按 Mac 的处理器架构手动选择。便携 `.tar.gz` 与 `.zip` 仍保留在 GitHub Release 中，但网站只提供可直接安装的 DMG、DEB 和 MSI。

`xattr` 只会移除这个应用的 macOS quarantine 元数据，不会创建签名或公证。应用安装在其他目录时，替换为实际路径。不要为了运行预览版而全局关闭 Gatekeeper。

Windows MSI 可以在 PowerShell 中核对哈希、移除该文件的 Zone Identifier 后启动：

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi" -Algorithm SHA256
Unblock-File -Path "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi"
Start-Process "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi"
```

使用 ZIP 时，先对 ZIP 执行 `Unblock-File`，再解压。若 SmartScreen 仍然出现，在已经核对来源和哈希后选择 **More info** > **Run anyway**。`Unblock-File` 只会移除下载文件的 Zone Identifier，不会创建 Authenticode 签名。不要全局关闭 Defender 或 SmartScreen。完成平台签名的稳定版（macOS 另需公证）通常不需要这些手动步骤。

## 小游戏

使用 `--game` 打包未加密、已解包的小游戏产物，并通过 QuickJS simulator 启动：

```sh
pnpm container:pack -- ./game-dist --game --out ./artifacts/game
cargo run -p container-simulator --features quickjs-native -- \
  run --pack ./artifacts/game --snapshot ./artifacts/game/snapshot.json
```

运行时提供 Canvas 2D 子集和 requestAnimationFrame。宿主通过平台无关的 `game.event` 提交规范化触摸、键盘、传感器、音频中断和内存告警事件。显示/隐藏沿用 `app.lifecycle`，viewport 更新会调整游戏 Canvas 并通知 `wx.onWindowResize`。事件载荷见 [game-event-v1.schema.json](schemas/game-event-v1.schema.json)。小游戏 API 仍按清单和宿主能力协商，官方 DevTools、GPU 与设备一致性尚未验证。

## 开源小程序示例

`examples/apps/community/` 收录了上游 `miniprogram-demo` 文本页、Ant Design Mini 按钮组件和 Taro blended-basic 页面三个经过整理的可运行快照。每个样例保留上游 MIT 许可证，并在目录说明与 `SOURCES.json` 中记录仓库、固定提交和本地调整。

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/community/miniprogram-demo-text" -p weapp \
  --outDir "$PWD/artifacts/community/miniprogram-demo-text/raw"
pnpm container:pack -- artifacts/community/miniprogram-demo-text/raw \
  --out artifacts/community/miniprogram-demo-text/pack \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
cp examples/apps/community/miniprogram-demo-text/LICENSE.upstream \
  artifacts/community/miniprogram-demo-text/pack/LICENSE.upstream
pnpm simulator:dev:smoke -- \
  --project examples/apps/community/miniprogram-demo-text
```

另外两个样例将命令中的 `miniprogram-demo-text` 分别替换为 `ant-design-button` 和 `taro-blended`。样例列表、逐项命令和来源见 [`examples/apps/community/README.md`](examples/apps/community/README.md)。

在浏览器中保持模拟器运行：

```sh
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/community/miniprogram-demo-text --surface web
```

## 许可证

Apache-2.0。请阅读 [NOTICE](NOTICE) 和 [SECURITY.md](SECURITY.md)。
