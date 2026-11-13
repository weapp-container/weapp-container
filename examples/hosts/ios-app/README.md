<a id="ios-embedding-and-metal-surface-examples"></a>
# iOS 嵌入和 Metal 绘制表面示例

**简体中文** · [English](README.en.md)


此目标是 `examples/hosts/ios` 的应用支持版本。Swift 包仍用于可重用的库/ABI 检查；此目标拥有一个可见的 `UIWindow` 和一个 `CAMetalLayer`，因此 CoreAnimation 可向 Rust Skia Ganesh 提供真实的可绘制表面。

从仓库根目录：

```sh
scripts/ios-app-smoke
scripts/ios-embedding-smoke
```

脚本为 `aarch64-apple-ios-sim` 构建 `container-host-ios`，使用 `xcrun swiftc` 编译 UIKit 应用，生成一个签名的模拟器 `.app`，安装到唯一启动的模拟器（或 `WEAPP_CONTAINER_IOS_SIMULATOR_UDID`）上，通过 `simctl launch` 启动它，并要求直接进行 `WEAPP_CONTAINER_SURFACE_PROBE`，参数为 `containerSurfaceAttached=true`、`gpuSurface=true` 和 `rendererBackend=skia-gpu-metal`。

该应用编译共享的 `WeappContainerHost/Bridge.swift` 和 `PortablePack.swift`；两个 iOS 示例共用一个 Swift 加载器和一套 C 头文件 ABI。脚本验证仓库中签入的 Swift package portable pack，再将其复制到已签名的 `.app`。使用 `WEAPP_CONTAINER_IOS_PACK=/absolute/path/to/pack scripts/ios-app-smoke` 可指定其他输入包。

加载器在加载清单之前会验证完整性根和所有 blob 的 SHA-256 值。它通过 `app.init` 执行实际的模块字节，发送 `app.lifecycle` 启动和 `page.push` 消息，然后将路由的 WXML/WXSS 与实时 JavaScript 页面数据一起提交。启动错误会被写入 `Library/Caches/weapp-ios-evidence.json` 并在应用中显示。表面证据包括相关联的启动请求/响应、引擎、会话、快照/帧 ID、路由和清单完整性根，并要求 Metal 命令缓冲区成功完成。运行时句柄调用和 Metal 解离操作仍保留在主线程。

最新的运行时帧直接渲染到视图支持的可绘制表面中。
不使用 RGBA 快照上传作为 GPU 证据。默认仍为一个单帧的“烟雾”应用。其透明的预乘 Metal 图层被合成到白色 UIKit 宿主视图上。运行时和原始 `frame.png` 保留其 alpha 通道。
应用在渲染完成后仍保持存活，直到烟雾监督器通过模拟器捕获 `app-screen.png` 并清理其拥有的包。`screen-capture.json` 记录了运行中应用的 PID 和操作系统截图哈希。仅凭运行中 PID 无法证明前台拥有权或视觉正确性；需单独检查操作系统截图与可绘制表面回传内容。
`WEAPP_CONTAINER_IOS_ENGINE=quickjs|v8` 同时选择构建特性与运行时配置；不可用的 V8 目标构建会明确失败。
默认仍为 QuickJS。持续的 OS 输入/定时器验收和设备验证仍为独立工作。仅凭构建或源码检查无法证明模拟器、设备或 GPU 的合规性。

`ios-embedding-smoke` 设置 `WeappContainerAppMode=embedding` 并运行 `WeappContainerEmbeddingViewController`，该控制器嵌入共享的 `WeappContainerView`。它拥有一个活跃的 Rust 会话，一个基于显示链接的定时器泵，批量触摸事件，逻辑尺寸调整，前台切换以及 Metal 的资源回收/分离/卸载。其首帧回执使用独立的 `ios-skia-metal-embedding` 源码，并记录一个仍处于打开状态的会话；它无法替代默认烟雾测试中完成的分离操作。后续操作进入有界的 `embedding-trace.json`，在应用清理前将其复制输出。这些脚本在捕获完成后会卸载其任务应用。要将一个持久性功能嵌入应用程序中，请重用该控制器/视图，并在完成时调用 `close()`。有关启动几何形状、当前路由样式选择、资源复用和输入限制的详情，请参见 [嵌入合约](../../../docs/ios-portable-pack.md)。

Swift 引用的 C ABI 函数是普通静态归档链接的基础，使用 `-dead_strip` 来移除未使用的传递代码。该应用不会强制加载完整的 Rust 归档文件。被锁定的 rusty_v8 iOS 归档文件禁用了 Wasm，但包含未使用的 Wasm 编译包装器，这些包装器缺少可用的 C++ 定义；保留每个归档符号会使这些包装器成为链接依赖项。此链接策略不会增加 Wasm 支持，也不会更改所选的 JS 引擎。

每个运行都会保存 `source-before.json`、`build.json` 和 `execution-evidence.json`。
监督器捕获 `app-stdout.log` 和 `app-stderr.log`，并保存 `startup-wait.json`。它会轮询精确启动的 PID 以及匹配的会话/引擎证据。原生引擎在启动时失败会立即终止启动，并保留最后的原始 `evidence.json`；它不会被视为截图失败或 GPU 通过情况。
构建溯源会哈希实际签名的可执行文件，并在编译前后检查 Rust/Swift/构建输入。编译过程中源码发生变更将失败；未提交的构建将保持为 `unknown`。`CARGO_TARGET_DIR` 选择 Cargo 输出目录（相对路径从本仓库解析）。监督器会明确将该目录传递给 Cargo，从 `cargo-build.jsonl` 中选择宿主静态库，并将其复制到运行独立的 `native-input/libcontainer_host_ios.a`。Swift 会链接该精确文件，而不会搜索默认目标目录。`native-archive.json` 记录所选的构件、引擎/特性及 SHA-256 值；链接/签名后会再次验证复制的归档文件。后续构建无法替换该运行的链接输入。`WEAPP_CONTAINER_IOS_FIXTURE_ID` 指定共享一致性测试构件；其他宿主和引擎必须使用相同的清单。单个模拟器回执无法满足完整的宿主矩阵要求。

烟雾使用默认的唯一捆绑标识符和运行目录。所选启动的模拟器上必须没有显式的捆绑标识符；现有应用得以保留。`resources.json` 记录安装/启动的所有权和进程 ID（PID）。清理查询会精确匹配捆绑标识符和 PID，区分正常退出和持续拥有进程的情况，卸载其捆绑包，并写入 `cleanup.json`。身份变更和清理失败将被报告并导致命令失败；借来的模拟器和无关应用将继续运行。在未获得成功确认的情况下尝试安装（包括在确认记录之前被中断），不会授予清理所有权。这种情况会保留模糊的捆绑标识符，在 `cleanup.json` 中写入 `blocked-unowned`，并导致命令失败。在没有记录 PID的情况下中断启动，也会保留任何正在运行的进程，直到其所有权得以确立。
