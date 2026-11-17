# weapp-container

**简体中文** · [English](README.en.md)

独立的开源便携运行时，用于在受控进程中加载小程序格式的页面、组件、脚本和样式。项目提供 manifest 打包器、Rust 运行时、QuickJS/V8 执行引擎、模拟器以及 Node 测试绑定。

本项目与任何第三方平台、品牌、服务或 SDK 没有隶属、授权或商业合作关系。仓库只提供便携运行时、清单格式和兼容性接口名称，不包含官方工具、原生平台 SDK、账户系统或外部服务桥接。所有外部权限与网络能力都由调用方自行实现。

## 快速开始

```sh
pnpm install
pnpm container:manifest:test
pnpm conformance:verify
pnpm api:inventory:verify
```

Node 绑定只消费源码目录或已生成的 portable pack。编译器、宿主服务和外部网络由调用方自行选择和管理。

## 许可证

Apache-2.0。请阅读 [NOTICE](NOTICE) 和 [SECURITY.md](SECURITY.md)。
