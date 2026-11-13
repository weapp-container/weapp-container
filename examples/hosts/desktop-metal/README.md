<a id="desktop-skia-metal-surface-smoke"></a>
# 桌面 Skia Metal 绘制表面烟雾

**简体中文** · [English](README.en.md)


此独立的 macOS 烟雾测试验证了 GPU 所有权边界：

1. 创建一个 winit AppKit 窗口和 `CAMetalLayer`；
2. 在 `native-gpu` 页面模式下初始化运行时，然后创建 `MTLDevice`/`MTLCommandQueue` 并将其附加到该会话；
3. 将每个 `CAMetalDrawable` 纹理包装为 Skia Ganesh Metal 渲染目标；
4. 使用运行时渲染器渲染已提交的 `RenderFrame`，执行刷新，并呈现/提交可绘制对象；
5. 在命令提交后确认其渲染器拥有的修订版本，验证在呈现前后均未缓存 CPU 页面快照；
6. 解除 Metal 上下文，卸载会话，退出事件循环并释放任务拥有的窗口。

在 macOS 图形会话中运行：

```bash
cargo run --manifest-path examples/hosts/desktop-metal/Cargo.toml --release --locked
```

JSON 报告只有在运行时报告
`rendererBackend: "skia-gpu-metal"`，`containerSurfaceAttached: true`，和
`gpuSurface: true`，两个 `cpuSnapshotAbsent*` 检查，以及成功的呈现 ACK 时才会被 `passed`。`frameId: 37` 故意与渲染器版本不同。提交已观察到；未断言 GPU 完成和视觉像素正确性。
窗口创建失败会发出 `blocked` 报告；可绘制/呈现失败会发出 `failed`。Linux 和 Windows 构建会明确发出被阻塞的形状；它们不会将软件呈现器转为 GPU 证据。

进程在一次呈现后退出，不拥有任何持久化服务。报告记录了上下文解离、会话卸载、事件循环返回和窗口所有者销毁。如果被外部中断，应在清理仅属于任务的资源之前，检查记录的进程和唯一标题为 `Weapp Container Skia Metal smoke` 的窗口。
