<a id="web-embedding-example"></a>
# Web 嵌入示例

**简体中文** · [English](README.en.md)


此页面是一个小型应用侧 Web 宿主。它消耗模拟器的公共批处理边界，将一整帧 RGBA 快照绘制到画布上，并通过 SSE 监听 `ready`、`reload`、`snapshot`、`diagnostic`、`error` 和 `shutdown` 事件。它从不遍历 WXML 节点，也不为每个像素或节点发送一次桥接调用。
在 `state.presentation` 模式下，页面会获取 `/api/frame` 的二进制 RGBA 批量数据，并检查其会话、配置版本和逻辑视口。输入使用独立于画布密度和显示缩放的逻辑尺寸。逻辑尺寸调整会取消已排队的输入，并挂起旧画面，直到匹配的帧被呈现。每次请求仅保持一个飞行状态；后续请求将合并处理。没有呈现元数据的旧版适配器仍可使用 `/api/snapshot` JSON 和完整快照事件。服务器将二进制帧存储限制在 64 MiB，SSE 重放限制在 256 个事件 / 2 MiB，SSE 连接数限制在 16。

使用本地 Web 绘制表面启动开发模拟器：

```sh
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/reference-app --surface web
```

打开 [http://127.0.0.1:5179/embed](http://127.0.0.1:5179/embed)。该页面由模拟器提供服务，因此它使用与内置检测器相同的源和会话。编辑 WXML/WXSS 文件以观察即时重新加载；编辑 JavaScript 或应用配置以观察会话重启。

端点是`container-host-web`的开发适配器。生产环境的浏览器主机可以将HTTP调用替换为`WebWasmHost`方法，同时保持相同的`load_manifest → start_session → dispatch_batch →
render_snapshot_rgba`调用顺序。本示例不声明CanvasKit GPU、DevTools、模拟器或设备的兼容性。

在浏览器内部执行时，请使用单独的
[`WebAssembly embedding example`](../web-wasm/README.md)。它拥有一个 QuickJS/WASM 会话，并且从静态文件加载可移植模块，而无需模拟器的 HTTP 运行时端点。其当前的软件渲染器存在明确的文本和 CanvasKit 限制。
