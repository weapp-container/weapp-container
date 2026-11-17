# container-host-web

**简体中文** · [English](README.en.md)


Web 生命周期边界。`load_manifest_json` 进行验证并拥有一个共享的 `container-runtime::Session`；`dispatch_json` 在 WASM/JavaScript 之间完全桥接并以批次形式传递。`wasm,quickjs-native` 构建一个浏览器的 cdylib，可在 QuickJS/WASM 内部执行相同的可移植模块。参见 [`web-wasm` 应用示例](../../examples/hosts/web-wasm/README.md) 了解静态部署和构建命令。`canvas-kit` 仍保留为一个预留的渲染边界；它不附加 CanvasKit 或 GPU 上下文。能力元数据和原生宿主测试并不能确立浏览器合规性。

`start_session` 发送 `app.init`，而 `dispatch_lifecycle` 通过核心状态机路由有序的启动/显示/隐藏/卸载过渡。
`poll_timers` 让浏览器事件循环提供 Unix 时间戳纳秒，并接收一个包含该时刻所有待执行回调的 JSON 批量。传递经过检查的 `BigInt(Date.now()) * 1_000_000n`，而不是 RAF 的相对时间戳；[共享定时器时钟合约](../container-host-common/README.md) 定义了其范围和时钟域。

在 `render.commit` 之后，`render_snapshot_json` 返回一个 JSON 格式的 `RenderSnapshot`，其中包含紧密打包的预乘 RGBA8 像素。WASM 包装器也暴露了相同的方法，因此 CanvasKit/ImageData 的上传仍只需一次边界穿越。对于热帧，`render_snapshot_rgba` 返回与像素相同的 typed `Uint8Array` 兼容缓冲区，并避免了 JSON 数值的扩展；宽度、高度和行距仍可通过元数据方法获取。

`quickjs-native` 和 `v8-native` 特性使共享运行时中的提供者能够运行。能力元数据反映了该运行时编译的提供者，包括由其他工作区消费者启用的特性。当共享运行时没有 V8 提供者时，V8 请求会报错 `ERR_ENGINE`；它们永远不会选择其他引擎。

`WebWasmHost::load_manifest_json_with_config` 接受序列化的 `SessionConfig`，其中明确指定了引擎和会话 ID。WASM 包装器需要实际编译的提供者；如果引擎不可用，则返回 `ERR_ENGINE`，而不会更改现有会话。默认加载方法需要manifest的完整性。

浏览器时钟使用 `web-time`；QuickJS 通过 wasm-bindgen 接收本地时钟导入。在 macOS 上，编译和链接 QuickJS WASM 对象需要 LLVM clang 和 llvm-ar。一个原生的 `ar` 工具，会丢弃 WASM 对象，即使仅检查 rlib 成功，也无法生成可运行的模块。开发配置文件会优化 C 解释器，以避免宿主栈溢出，同时保留 Rust 调试符号。
