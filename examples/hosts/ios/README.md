<a id="ios-host-sample"></a>
# iOS 宿主示例

**简体中文** · [English](README.en.md)


默认的原生集成检查会构建 `WeappContainerHost` 库，以便在任何 macOS CI 运行器上运行。只有在可用 Rust 静态库和 iOS 模拟器 SDK 时，才构建模拟器烟雾可执行文件：

```sh
WEAPP_CONTAINER_IOS_RUST_LIB="$PWD/../../../target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a" \
swift build --package-path . --triple arm64-apple-ios-simulator --product WeappContainerSmoke
```

可执行文件加载已检出的 `Resources/portable-pack`，该文件来自 `artifacts/reference-app/pack`。它在加载 Rust 会话之前，会验证清单的完整性根以及所有引用的模块、视图脚本、WXML/WXSS 和资源 blob。启动流程包括 `app.init`（模块和 blob）、`app.lifecycle`（启动）、`page.push`，以及基于模板的 `render.commit`；渲染读取由 JavaScript 产生的实时页面数据。随后进行 RGBA 快照回读和 `wx.canIUse` 的测试。将其安装到模拟器中是一个独立的应用包步骤。

刷新或从仓库根目录检查该 fixture：

```sh
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack --check
scripts/test-ios-portable-pack
scripts/test-ios-container-session
```

`WeappPortablePack(directory:)` 是一个可复用的文件系统/包加载器。调用 `try pack.start(on: host)` 来运行检查启动序列。结构化桥接错误、不可用的 JS 引擎、缺失的确认和被拒绝的帧会抛出 `WeappPortablePackError`。已接收的帧会在 `WeappPortablePackStartup.diagnostics` 中保留后续运行时诊断信息。有关集成和验证边界，请参见 [`docs/ios-portable-pack.md`](../../../docs/ios-portable-pack.md)。

对于交互式 UIKit 嵌入，创建 `WeappContainerView(pack:engine:)` 在主线程，将其添加到视图层次结构中，并在功能完成后调用 `close()`。它拥有一个 `WeappContainerSession` 和直接的 Rust Skia `CAMetalLayer` 渲染。布局更新使用逻辑 UIKit 坐标进行运行时几何计算，使用屏幕缩放像素进行可绘制区域的渲染。窗口移除和应用/自身场景的停用会挂起同一会话；激活时会恢复会话而不会重放启动过程。显示链接目标和生命周期观察器在关闭时释放。缺少原生渲染是错误；可绘制区域暂时缺失时会重试而不切换渲染器。

自定义绘制表面拥有者可以直接使用 `WeappContainerSession`。其运行时协议在现有包协议基础上增加了 `resize`、`pollTimers`、`sessionState` 和 `unload`。所有调用必须在会话创建线程上执行。定时器轮询使用 `WeappContainerSession.clockNowNs()`（Unix纪元纳秒），而不是 `CADisplayLink.timestamp` 或运行时 uptime。空的定时器批次将跳过渲染；回调效果和输入渲染将基于当前原生页面路由，保持实时数据。`sessionState` 仅传递会话 ID、视口、当前页面和上一帧 ID，不包含渲染树或像素缓冲区。

初始输入合约支持单点触控和轻触识别。UIKit 事件合并为一个 `event.batch`，Rust 对提交树进行命中测试和事件传播。多个触控会取消当前手势；原生目标捕获、多点触控、长按、原生滚动手势、文本输入组合、可访问性以及完整的显示/安全区域度量仍不完整。`onError` 会报告失败。呈现或 `ERR_RENDER` 失败会暂停输入和自动重绘，而前台业务定时器继续运行；它不会合成应用 `hide`。调用 `try containerView.render()` 以重试最新页面。在该帧 Metal 成功完成并得到确认后，输入将恢复。严重的运行时/协议错误会停止调度并需要新建会话。自定义绘制表面所有者使用 `suspendPresentation`、`render`、`consumePresentationAcknowledgement` 和 `resumePresentation` 进行相同的边界操作；就绪/观察器诊断信息仍保留在会话操作日志中。`close()` 在生命周期/原生卸载前会清空/解绑 Metal，并在钩子抛出异常时继续清理。不要在多个绘制表面所有者之间共享同一个会话。

`scripts/test-ios-container-session` 使用录制运行时在没有设备的情况下验证这些 Foundation 所有权合约。`swift build --target
WeappContainerHost` 检查 macOS 库/导入表面；它排除了仅 UIKit 的视图。UIKit 的编译和呈现需要 iOS SDK 以及模拟器/设备验证。这些本地合约检查单独都无法证明官方 DevTools 一致性或物理 GPU/设备的接受。

这个 Swift 包是 Rust iOS 宿主的最小应用集成点。`WeappContainerHost` 拥有一个线程相关的 `container-host-ios` 处理句柄，并交换完整的 UTF-8 JSON 桥接批次。Xcode 应用可以添加此包，链接 Cargo 生成的静态库，并从其 `UIViewController`/Metal 绘制表面拥有者中调用 `loadManifest`、`start` 和 `dispatch`。

`MetalSnapshotPresenter` 是该所有者的绘制表面适配器。在生产级 GPU 路径中，传递来自视图的 `CAMetalLayer`，调用一次 `attach(runtime:)`，并在每个提交帧后调用 `present(runtime:)`。Rust Skia Ganesh 会直接将内容渲染到可绘制纹理中，返回的 `MetalSurfaceProbe` 会记录 `containerSurfaceAttached: true`、`gpuSurface: true` 和 `rendererBackend: "skia-gpu-metal"`。独立的烟雾测试使用没有 UIView 层级的层，如果 `nextDrawable()` 不可用，则会记录一个单独的 `blocked` 结果。

`present(snapshot:)` 仍适用于仅拥有完整 RGBA 帧快照的宿主。它上传一个 `MTLTexture`，并明确报告为 `rendererBackend: "software-fallback"` 且 `containerSurfaceAttached: false`；这并不能作为 GPU 兼容性的证据。

从仓库根目录开始，先构建 Rust 部分：

```sh
cargo build -p container-host-ios --features ios,metal,quickjs-native-ios --target aarch64-apple-ios-sim
swift build --package-path examples/hosts/ios --target WeappContainerHost
```

`swift build --target WeappContainerHost` 检查 macOS 上的库和 C 头文件 ABI。在 macOS 上不使用匹配的 Rust 静态库构建可执行文件，链接阶段预期会失败；使用上述 iOS 模拟器命令来构建可执行文件。`Package.swift` 为 Skia/QuickJS 静态库链接了 Metal、QuartzCore、CoreText 和 libc++。默认的 C ABI 配置使用 QuickJS。`pack.start(on: host, engine: "v8",
sessionID: "my-ios-session")` 使用显式配置的 ABI；其匹配的 Rust 静态库必须包含 `v8-native`。缺少提供者将无法回退。现有的 `pack.start(on: host)` 以及原始的 C ABI 仍然可用。仅一个引擎选择器并不能确定 V8/iOS 的支持范围。该包本身不声明对模拟器或设备的兼容性；最终的 Xcode 链接必须添加匹配的 `libcontainer_host_ios.a`、`Security.framework`/其他提供者框架（如需）以及一个与 Rust 兼容的 Objective-C 运行时配置。
