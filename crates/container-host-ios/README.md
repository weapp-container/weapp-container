# container-host-ios

**简体中文** · [English](README.en.md)


iOS 静态库和 Swift/Objective-C 桥接边界。共享运行时通过 `load_manifest_json` 加载，并通过 `dispatch_json` 完整批次交换。`ios` 和 `metal` 是明确的集成特性；`skia-backend` 或实际的 `skia-gpu-metal` 特性宣布编译后的 Skia 边界。默认测试仅检查元数据和协议行为；它们不声称模拟器或设备验证。

`build.nativeSurface`/`build.renderer` 描述编译边界。在首帧提交前，它们可能报告 `skia-raster`；`runtime.gpuSurface` 保持为 `false`，直到Rust Skia 渲染到宿主拥有的 Metal drawable。

`weapp_container_ios_host_capabilities` 返回一个版本化的 JSON 报告，将编译后的渲染器/提供者特性与当前会话分开。`runtime.gpuSurface` 直到 Swift/Objective-C 适配器挂载了真实的 Metal 上下文之前都保持为 false；CPU 光栅读回操作单独报告，无法满足 GPU 门禁要求。

`start_session` 和 `dispatch_lifecycle` 在 Swift/Objective-C 绘制表面回调附加之前，保持生命周期的顺序，该顺序在共享的 Rust 运行时中实现。

`notify_viewport_resize_json(width, height)` 更新逻辑视口指标，并调用缩放钩子，但不会替换会话或提交帧。
`session_state_json()` 仅返回版本化的会话 ID、逻辑视口、当前页面 `{id, route}`（或 null）、视图修订版本，以及最后提交的 `frameId`（或 null）。
此轻量级读取操作从不序列化渲染树或像素。 缩放不会生成新的帧 ID；绘制表面的所有者必须进行渲染和呈现。

`poll_timers`/`poll_timers_json` 接收 **Unix 时间戳纳秒**，与原生定时器调度和 JavaScript `Date.now()` 保持一致。宿主不得传递显示链接时间戳、运行时长度或会话相对的经过时间。每次轮询返回一个完整的桥接批次，可能包含零条消息。宿主拥有事件循环，并必须检查错误信封以及 FFI 状态。

`quickjs-native` 和 `v8-native` 特性使共享运行时中的提供者能够运行。能力元数据反映了该运行时编译的提供者，包括由其他工作区消费者启用的特性。当共享运行时没有 V8 提供者时，V8 请求会报错 `ERR_ENGINE`；它们永远不会选择其他引擎。

`staticlib` 导出 `weapp_container_ios_host_new/free`、`weapp_container_ios_host_load_manifest`、`weapp_container_ios_host_start`、`weapp_container_ios_host_dispatch_json`、`weapp_container_ios_host_dispatch_batch_json`、`weapp_container_ios_host_capabilities`、`weapp_container_ios_host_render_snapshot`、`weapp_container_ios_host_canvas_snapshot`、`weapp_container_ios_host_poll_timers`、`weapp_container_ios_host_resize_viewport`、`weapp_container_ios_host_session_state`、`weapp_container_ios_host_unload` 和 `weapp_container_ios_buffer_free`；`examples/hosts/ios` 包含 Xcode 应用使用的 Swift 包和 C 头文件。

原生卸载是幂等的，并且会清除定时器、提供者和引擎状态，同时保留可重用的宿主句柄。它不会调用应用程序钩子：在需要运行这些钩子时，应先分发 `app.lifecycle` 事件并传入 `unload`。抛出异常的钩子不得阻止原生释放。在释放后，直到加载新的清单，状态/调整大小/定时器/分发调用都将失败。每个返回的 FFI 缓冲区仍由调用方拥有，并必须使用匹配的缓冲区释放函数进行释放。

Swift 适配器符合 `WeappContainerSessionRuntime`。
`WeappContainerSession` 提供整个会话的输入、定时器、前台和导航感知的渲染所有权。UIKit 应用使用 `WeappContainerView`，该视图将这些操作保留在主线程，并直接将其绘制到 `CAMetalLayer` 中。该视图负责会话的销毁，包括显示链接/观察者清理以及 Metal  draining/detach 在卸载前的操作。它支持单指触控/轻点、触控目标捕获、多点触控/长按、原生滚动、文本输入组合、可访问性，以及完整的 iOS 窗口/显示观察均不在本实现中。有关嵌入和验证合约，请参见 [`docs/ios-portable-pack.md`](../../docs/ios-portable-pack.md)。

`weapp_container_ios_host_render_snapshot` 在完成一个 `render.commit` 后返回一个 JSON `RenderSnapshot`；Swift 可以将预乘 RGBA8 像素上传到一个 Metal 绘制表面，而无需为每个节点进行桥接调用。这是软件回退路径，必须保持报告为 `containerSurfaceAttached: false`。

对于直接的 GPU 路径，使用 `ios,metal,quickjs-native-ios` 编译。Swift 的 `MetalSnapshotPresenter.attach(runtime:)` 方法将应用拥有的 `MTLDevice`/`MTLCommandQueue` 绑定到 Rust Skia Ganesh；`present(runtime:)` 方法将 `CAMetalLayer` 的可绘制纹理进行包装，并直接将最新提交的帧渲染到该纹理中。只有在该调用成功之后，探针才会报告 `source: "ios-skia-metal-layer"`、`rendererBackend: "skia-gpu-metal"` 和 `containerSurfaceAttached: true`。无可绘制层的无头模拟器可能没有可绘制内容；该结果为 `blocked`，不属于软件或 GPU 通过情况。

`weapp_container_ios_host_canvas_snapshot` 通过 UTF-8 canvas id 读取已提交的 `wx.canvas.draw` 绘制表面。返回的批处理与页面快照独立，并可一次性上传到 Metal 层。
