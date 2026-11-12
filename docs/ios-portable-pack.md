<a id="ios-portable-pack-embedding"></a>
# iOS 可移植包嵌入

**简体中文** · [English](ios-portable-pack.en.md)


Both iOS 示例都使用 `examples/hosts/ios/Sources/WeappContainerHost`：

- `Bridge.swift` 管理一个线程相关的 Rust 会话，并导入 C 头文件。
- `PortablePack.swift` 读取一个包或文件系统包，并在调用主机之前进行验证。它不依赖 UIKit、Metal、Rust 或模拟器。
- `ContainerSession.swift` 管理实时输入、定时器泵送、导航感知的渲染、前台过渡和最终卸载。其运行时协议扩展了加载器协议，并且可以在没有 UIKit 或 Rust 的情况下进行测试。
- `WeappContainerView.swift` 将该会话嵌入到一个基于 UIKit 的 `UIView` 中，该 `UIView` 由 `CAMetalLayer` 支持，并使用 `MetalSnapshotPresenter` 实现对 Rust Skia 的直接输出。
- `WeappContainerSmoke` 通过 SwiftPM 打包一个签入仓库的参考包。
- `ios-app` 使用 iOS SDK 直接编译相同源码，并将选定的包复制到其 `.app/portable-pack` 中，然后进行签名。

```swift
let directory = Bundle.main.bundleURL.appendingPathComponent("portable-pack")
let pack = try WeappPortablePack(directory: directory)
let host = WeappContainerHost()
let started = try pack.start(on: host, width: 375, height: 667)
// Keep the host on this thread. Inspect started.diagnostics as well as frames.
```

对于一个交互式应用，在 UIKit 主线程中创建 `WeappContainerView`，并将其作为会话的唯一拥有者：

```swift
let pack = try WeappPortablePack(directory: directory)
let miniProgram = try WeappContainerView(pack: pack, engine: "quickjs",
    width: 375, height: 667)
miniProgram.onError = { error in print("Weapp Container:", error) }
miniProgram.translatesAutoresizingMaskIntoConstraints = false
view.addSubview(miniProgram)
NSLayoutConstraint.activate([
    miniProgram.leadingAnchor.constraint(equalTo: view.leadingAnchor),
    miniProgram.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    miniProgram.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
    miniProgram.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
])
// When the embedding feature finishes, on the main thread:
// try miniProgram.close()
```

提供预期的逻辑启动大小，以便 `App`/`Page` 初始化能够看到该视口。后续的布局使用运行时的四舍五入逻辑 UIKit 像素和 Metal 可绘制表面的物理像素。视图会调整大小并渲染现有会话，而不是加载另一个应用。它需要原生的 Rust 宿主和 Metal 后端；如果缺少原生渲染，则会报错。临时不可用的可绘制表面将保持脏状态并会被重试。

在宿主首次变为前台激活之前，一个缺失或不活跃的窗口仅会暂停输入和显示泵。初始启动时已调用 `App.onShow`；初始窗口附加和激活会保持该状态，而无需隐藏/显示配对操作。在第一次激活之后，窗口移除和应用/自身场景的去激活会触发相应的隐藏过渡；重新附加/激活会恢复相同的会话。成功完成命令缓冲区会触发 `onPresented`；仅提交一帧并不等同于完成呈现。

`close()` 会失效显示链接，移除观察者，取消输入，清空/解绑 Metal 并卸载原生会话。如果钩子或更早的清理步骤抛出异常，清理操作将继续。显式关闭是幂等的；去初始化也会释放主队列上所拥有的资源。

具有自定义绘制表面的应用程序可以拥有
`WeappContainerSession(pack:runtime:engine:sessionID:route:width:height:)`。
在其创建线程上调用 `pointer`、`setForeground`、`resize` 和 `pollTimers`，在 `session.close()` 之前 draining/detach 自定义绘制表面。运行时事务失败会记录诊断信息并停止后续输入和定时器工作。在原生释放之前会尝试生命周期卸载，即使事务失败也是如此。不要通过第二个所有者来修改其原生宿主。
会话本身在隐藏、调整大小或卸载前会发送 `touchcancel`；自定义绘制表面的所有者无需实现第二次取消操作。
`onOperation` 和 `onDiagnostic` 观察者在完整周围事务完成之后运行，包括确认验证和发布。观察者可以在该点关闭会话，而无需在待渲染之前卸载。这些观察回调报告已完成的工作，而不是提供输入或生命周期注入点。

会话的定时器输入是**Unix 时间戳纳秒**，通过 `WeappContainerSession.clockNowNs()` 获取。`CADisplayLink.timestamp`、设备启动时间以及会话创建以来的时间使用不同的时间起点。触摸事件的 `timeStamp` 故意使用 UIKit 的单调毫秒时间。每次 tick 读取轻量级的原生页面/版本元数据。当路由、页面身份或视图版本发生变更时，将使用实时页面数据进行渲染，包括 JS 导航、`setData` 以及延迟的就绪/观察器效果。即使定时器批次为空，仍可能触发该脏渲染；若 tick 未发生变更，则不会触发。后续的清单帧使用 `useSessionResources: true` 以复用会话已验证的资源，而无需重新传输其字节。初始渲染提供明确的二进制数据块。当前路由的渲染按清单顺序选择应用、页面以及递归使用的组件样式。

输入目前支持一个指针，`touchstart`/`touchmove`/`touchend`/`touchcancel`，以及一个持续最多 500 毫秒且未移动的接触的结束加点击批次。第二个接触会取消该手势。坐标和点击容差使用逻辑点；运行时从已提交的树中获取目标、数据集和传播信息。已识别的接触在移动过程中保持其按下时间节点、监听器、数据集和组件路径。页面切换、目标移除和视口变化会取消该接触；延迟结束或点击无法选择替代目标。运行时和两个原生引擎均将此作为本地合约进行测试；固定基准的微信等效性仍未经验证。多点触控、长按、原生滚动、键盘/文本输入组合以及 UIKit 可访问性树均未由该视图实现。其仅提供视口大小的边界，也未提供完整的 iOS 显示/安全区域/方向观察功能。这些功能仍为独立的实现和合规性工作。

`scripts/ios-app-smoke` 也支持 `WEAPP_CONTAINER_IOS_BUILD_ONLY=1`。
它在任何模拟器命令之前创建一个签名应用和版本化的 `build-product.json` 回执。这使得官方 XCUITest 运行器可以自行执行后续的安装、操作系统输入、启动和清理操作。仅用于验证的 `WEAPP_CONTAINER_IOS_UI_OBSERVATION=1` 构建会暴露一个可访问的锚点，并提供有界只读的会话/页面元数据。普通嵌入式构建不会暴露页面数据。观察功能使用 `weapp_container_ios_host_inspect_state` 作为一个不可变批次，不进入 JS，不使用轮询定时器，也不通过 FFI 遍历节点。轻量级生产版 `session_state` 泵保持独立，且不会序列化应用程序数据。

加载器检查 UTF-8/模式 v1、SHA-256 完整性根、协议主版本，所有模块/视图脚本/模板/样式/资产引用和资产大小。缺失或损坏的 blob 文件以及逃逸打包的符号链接在会话加载之前就会失败。Rust 运行时还验证其完整模式、依赖项、能力、WXML/WXSS 以及支持的视图语义。Swift 标准化器支持当前 v1 元数据数值域：非负整数，最大值为 `Number.MAX_SAFE_INTEGER`（模式版本和资源字节大小）。浮点数、负数或更大的数值元数据会被明确拒绝；这并非通用的 RFC 8785/ECMAScript 数值标准化器。WXML/WXSS 表达式数据保留在哈希 blob 中，不受该清单-元数据限制。

已检出的测试组件使用可用的编译器归档文件（无 Git 来源）从重命名的参考应用重建而成。其 `compiler.commit` 确实为 `unknown`；它无法证明使用了固定版本的上游编译器构建。在可重现性或发布门禁之前，必须使用仓库中已验证的子模块重新构建它。

声明的 WXS 和编译后的表达式数据块使用运行时的隔离视图引擎。仅凭字节传输无法证明 WXS 语义或官方一致性。

启动会按此顺序发送完整的 JSON 批量：

1. 通过 C ABI 加载清单。
2. 使用 `app.init` 加载所有模块、已验证的二进制文件和启动选项。
3. 使用 `app.lifecycle` 与 `launch` 操作。
4. 使用 `page.push` 推送选定的路由。
5. 使用 `render.commit` 提交该路由的模板、样式、二进制文件和视口。

渲染请求省略了 `data`，保留了由 JS 注册、`onLoad` 和 `setData` 产生的当前页面状态。提供的路由必须存在且具有匹配的模板；加载器不会替换合成帧。每个响应都必须通过会话/操作/请求 ID 进行关联，包含响应类型并确认成功。`app.init` 必须报告一个真实的引擎提供者；`render.commit` 必须明确确认发布。结构化运行时错误保留其 `ERR_*` 代码。在已接受帧之后发生的错误将出现在启动诊断中；示例应用会将其记录为启动失败。

原始的C ABI默认使用QuickJS。添加函数`weapp_container_ios_host_load_manifest_with_config`接受一个JSON格式的`SessionConfig`。在Swift中，使用`pack.start(on: host, engine: "v8", sessionID:
"my-session")`，并使用`v8-native`构建的静态库。缺少提供者将报错`ERR_ENGINE`，不会发生回退。自定义的旧版运行时实现可以保留其现有的加载器，但必须实现配置的重载以支持非默认的引擎/会话设置。仅选择本身并不能确立V8/iOS的执行覆盖。

原生 Swift 宿主在 `app.init` 之前接收到逻辑视口，因此在 `onLoad` 期间使用的窗口信息 API 和媒体查询看到的尺寸与渲染尺寸一致。其几何感知的重载是累加的；现有的自定义运行时实现保留其配置的加载器。

可添加的原生会话边界提供：

- `weapp_container_ios_host_resize_viewport`：逻辑宽度/高度和一个resize效果桥接批处理；帧发布仍作为一个独立的提交。
- `weapp_container_ios_host_poll_timers`：一个绝对Unix纪元纳秒观测的完整批处理。
- `weapp_container_ios_host_session_state`：仅包含 `{schemaVersion:1, sessionId, viewport:{width,height}, page:{id,route}|null,
  frameId:number|null, viewRevision:number}`。它不包含视图树或像素数据，并且即使视口已更改，也会报告最后接受的帧。
- `weapp_container_ios_host_unload`：幂等的原生释放，保留可重用的主机句柄。首先发送 `app.lifecycle(unload)` 以调用钩子。

Swift `WeappContainerHost` 暴露了这些功能为 `resize`、`pollTimers`、`sessionState` 和 `unload`，并符合 `WeappContainerSessionRuntime`。所有返回的 FFI 缓冲区都在每次 Swift 调用中被复制并释放。已卸载的会话会拒绝状态、重尺寸、定时器和分发操作；能力发现以及后续的清单加载仍可使用。

从仓库根目录：

```sh
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack --check
node --test scripts/sync-ios-portable-pack.test.mjs scripts/validate-ios-app-evidence.test.mjs
scripts/test-ios-portable-pack
scripts/test-ios-container-session
swift build --package-path examples/hosts/ios --target WeappContainerHost
```

同步脚本使用打包器的规范 JSON 实现，写入前验证所有源，发布时会发布一个暂存目录，并在发布失败时恢复之前的目标准备位置，支持精确字节 `--check`。`--destination` 选项可用于应用程序构建输出目录。
Swift 测试针对实际打包的参考字节和录制运行时进行，涵盖启动顺序、数据保留、完整性故障、引擎错误、相关性、发布确认和诊断。
会话测试使用录制运行时，涵盖输入批次、缩放、当前路由渲染、生命周期、定时器、错误挂起和卸载。
这些 Swift 测试不执行原生 JS 引擎，也不建立设备/GPU 证据。Rust 宿主测试涵盖原生元数据/缩放/卸载边界；macOS 库构建检查导入和条件编译，而 UIKit 和真实呈现需要 iOS SDK 和运行时门禁。

捆绑的测试用例是在 Weapp Container 重命名后，从 `examples/apps/reference-app` 重建的。其路由为 `pages/home/index`，完整性根为 `6da28a3a2e7194893d61209ba4b5f83afc5d72d429ba3fc9f6140106fcc9d8a1`。该本地构建使用了可用的非 Git 编译器归档文件，因此清单记录了 `compiler.commit: "unknown"`。该包是一个加载器/开发测试用例；它不满足固定上游可重现构建门禁。在将其作为发布证据使用前，请使用已验证的固定提交编译器刷新它。

当故意运行官方模拟器烟雾时：

```sh
WEAPP_CONTAINER_IOS_PACK=/absolute/path/to/pack scripts/ios-app-smoke
WEAPP_CONTAINER_IOS_PACK=/absolute/path/to/pack scripts/ios-embedding-smoke
```

该脚本编译 Rust 和 UIKit，仅在已启动的模拟器上安装其任务包，并读取其应用拥有的证据文件。通过表面探针需要一个已验收的基于包的帧、直接的 Rust Skia Metal 渲染以及命令缓冲区的成功完成。这并不意味着模拟器上启用硬件加速、性能验收、真实设备覆盖或与微信开发者工具在语义上的等价性。

`ios-embedding-smoke` 选择交互式 `WeappContainerView` 示例，而不是原始的单帧烟雾。其第一个完成的帧记录了 `source: "ios-skia-metal-embedding"` 和 `sessionOpen: true`；它没有声称已经断开的绘制表面。后续批次进入一个有界限的 `embedding-trace.json`，该文件在任务应用被移除前已复制。首次帧通过并不能证明持续的 OS 触摸输入或定时器行为。原始烟雾仍需要成功的 Metal 断开。两个脚本都会清理自身应用；嵌入控制器可以在应用自身的持久 UIKit 生命周期中复用。

`WEAPP_CONTAINER_IOS_ENGINE=quickjs|v8` 选择匹配的 Cargo 和运行时配置。`WEAPP_CONTAINER_IOS_SIMULATOR_UDID` 选择已启动的模拟器；脚本拒绝模糊的自动选择。构建回执将编译前/后的源代码绑定到实际签名可执行文件的 SHA-256。未提交的源代码保持为 `unknown`，编译过程中源代码的变更将失败。生成的 `execution-evidence.json` 将目标、引擎、会话、清单、请求/响应、快照以及 Metal 帧绑定到共享一致性矩阵中。

本地构建可能会警告，如果缓存的 QuickJS C 对象是使用比 Swift 应用声明的最低版本更新的 iOS SDK 部署目标编译的。仅成功链接并不能证明已支持声明的最低操作系统；部署目标对齐和在该操作系统上的执行仍是一个独立的门槛。

烟雾使用默认的唯一捆绑标识符和运行目录。所选的启动模拟器上必须没有显式的捆绑标识符；现有应用得以保留。`resources.json` 记录安装/启动的所有权和进程 ID（PID）。清理查询会精确匹配捆绑标识符/PID，区分正常退出和持续拥有进程的情况，卸载其捆绑包，并写入 `cleanup.json`。身份变更和清理失败将被报告并导致命令失败；借来的模拟器和无关应用将继续运行。
