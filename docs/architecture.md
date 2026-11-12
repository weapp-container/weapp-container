<a id="container-architecture"></a>
# 容器架构

**简体中文** · [English](architecture.en.md)


```text
原生小程序目录 / 任意兼容框架的构建产物
    ├── 原始微信目录（供官方 DevTools）
    └── container-manifest pack（独立打包工具）
            └── manifest v1 + content-addressed blobs
                    └── Rust container-core
                            ├── AppService（QuickJS / V8）
                            ├── View tree + batched data patches
                            └── Skia renderer
                                    ├── Web / CanvasKit WASM
                                    ├── Desktop / native window
                                    ├── Android / NDK
                                    ├── iOS / staticlib
                                    └── Harmony / FFI
```

打包与宿主接入不依赖 weapp-vite。它可以作为上游构建器之一；已有原生目录或其他框架的兼容产物直接进入同一条 portable pack 路径。

AppService、View 和 Renderer 通过批量 bridge envelope 连接。JS 运行时只提交状态变更和事件批次，渲染器在 native 侧完成布局、绘制和合成，避免逐节点跨语言往返。

宿主可为 QuickJS 设置覆盖整个操作的[执行时限](appservice-execution.md)，包括间接执行 JS 的呈现确认、resize 和清理入口；中断后的会话需要显式替换。

WXSS 的布局值在 runtime 根据当前 viewport 转成物理像素后写入共享
`LayoutStyle`。静态/相对定位参与父级 flex 流，绝对定位相对最近的
positioned ancestor，固定定位相对 viewport；四个 inset 边保持可选，以便
保留负值和相对两侧约束。`display:none` 会在 layout 阶段清除节点几何并从
流中移除，确保 selector、命中测试和各宿主截图观察到同一棵树。
`flex-direction` 的 `row-reverse`/`column-reverse` 从主轴末端布置子节点，
并保留 WXML 树顺序供事件和 selector 使用。

移动端宿主通过 `container-host-common::FfiBuffer` 的指针/长度 ABI 接入同一
`Session`：Android 的 JNI/CMake、iOS 的 Swift/C header 和鸿蒙的 ArkTS/N-API
示例都只负责线程归属、surface 生命周期和字节所有权，页面栈与协议状态仍由
Rust runtime 唯一维护。对应工程位于 `examples/hosts/`，可用
`scripts/build-native-hosts.mjs` 做结构和 cross-target 检查。

<a id="version-and-boundaries"></a>
## 版本与边界

- manifest schema 和 bridge protocol 独立版本化；启动时先协商版本和 capability matrix。
- 原始微信产物始终保留，portable IR 是可重建的派生物。
- Rust native 路径必须保留 JS/headless fallback，并以 `@mpcore/simulator` 和真实 DevTools 的可观察行为做差分测试。
- Android、iOS、鸿蒙和桌面是容器宿主，不加入 weapp-vite 的小程序编译平台表。
