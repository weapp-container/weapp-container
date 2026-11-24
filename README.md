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
