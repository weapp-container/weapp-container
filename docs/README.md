<a id="documentation-index"></a>
# 文档索引

**简体中文** · [English](README.en.md)


第一次使用请从[快速开始](https://container.weapp.dev/docs/start/)进入；本目录主要说明运行时实现和工程边界。网站提供相同工程文档的固定版本快照。

<a id="integration-and-development"></a>
## 接入与开发

- [独立打包工具](../tools/container-manifest/README.md)：原生小程序或已有框架产物转换为 portable pack。
- [SDK 仓库和源码构建](sdk-repositories.md)：目标平台、运行库、包装层与产物许可。
- [模拟器](simulator.md)与[设备客户端](dev-player.md)：开发预览、输入、设备连接和故障定位。
- [宿主服务](host-services/README.md)：能力协商、生命周期、消息、权限与验证。

<a id="implementation-and-protocols"></a>
## 实现与协议

- [总体架构](architecture.md)、[AppService 执行](appservice-execution.md)和[独立 View 引擎](isolated-view-engine.md)。
- [布局](layout-flow.md)、[文字](typography.md)、[图片](images.md)、[滚动](scrolling.md)、[变换](transforms.md)和[合成](compositing.md)。
- [双渲染路径](dual-renderer/README.md)：浏览器 DOM、Skia、呈现确认与输入所有权。
- [渲染模式](renderer-profiles.md)、[资源存储](render-resource-store.md)与[性能](performance.md)。

<a id="compatibility-releases-and-collaboration"></a>
## 兼容性、发行与协作

- [能力矩阵](capability-matrix.md)、[API 与 conformance](api-runtime-conformance.md)、[官方工具验证](conformance/README.md)。
- [源码构建依赖](rust-build-cache.md)、[平台归档](platform-runtime-artifacts.md)与[发行工具](../tools/runtime-artifacts/README.md)。
- [许可](licensing.md)、[公开源码策略](public-source-policy.md)、[历史证据](archived-evidence.md)与[旧归档迁移](runtime-artifacts-migration.md)。
- [贡献](../CONTRIBUTING.md)、[安全报告](../SECURITY.md)和[行为准则](../CODE_OF_CONDUCT.md)。

文档中的“实现”“构建”“运行”“验收”表示不同层级。单元测试、源码覆盖记录或某个宿主的结果不能替代其他平台的验收；未知项以待核验标注。
