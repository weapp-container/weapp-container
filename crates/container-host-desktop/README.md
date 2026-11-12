# container-host-desktop

**简体中文** · [English](README.en.md)


macOS、Windows 和 Linux 的宿主元数据及生命周期边界。宿主加载一个经过验证的可移植清单，并向原生事件循环暴露批量 `dispatch_json` 调用。`window` 和 GPU 特性是明确的集成点；拥有窗口时，无论使用 `skia-backend` 还是 `skia-gpu-metal`，元数据都会报告编译后的 Skia 光栅化边界。默认构建是确定性的，不声称具备原生 GPU/窗口验证。

`build.nativeSurface`/`build.renderer` 描述编译支持。`gpu_surface` 位直到平台绘制表面被渲染之前都保持为 `false`；因此，`metal-window` 构建在首次呈现前报告为 `skia-raster`，只有在 Metal 绘制表面路径成功后才会报告为 `skia-gpu-metal`。

`start_session` 和 `dispatch_lifecycle` 在共享运行时中保持应用初始化和生命周期的顺序，而不是在第二个桌面页面栈中实现。
`poll_timers` 让桌面事件循环提供 Unix 时间戳纳秒，并接收一个包含该时刻所有待处理回调的批次。运行时和经过的 `Instant` 值不是截止时间；请参见 [共享定时器时钟合约](../container-host-common/README.md)。

原生指针、滚轮和键盘事件可以使用 `DesktopInputEvent` 进行归一化，并通过 `DesktopHost::dispatch_input_batch` 作为单个 `event.batch` 发送。指针坐标保持在逻辑视口单位中；运行时执行命中测试，并在调用页面处理器前添加目标/路径/数据集字段。这使得 AppKit、Win32 和 winit 适配器保持相同的事件契约：

```rust,no_run
use container_host_desktop::{
    DesktopHost, DesktopInputEvent, DesktopModifiers, DesktopPointerPhase,
    DesktopTarget,
};

let mut host = DesktopHost::new(DesktopTarget::Linux);
// load_manifest_json(...) and start_session(...) happen before input.
let _batch = host.dispatch_input_batch(
    "pointer-1",
    [DesktopInputEvent::Pointer {
        phase: DesktopPointerPhase::Down,
        x: 24.0,
        y: 32.0,
        button: Some(0),
        buttons: 1,
        modifiers: DesktopModifiers::default(),
    }],
)?;
# Ok::<(), container_host_common::HostSessionError>(())
```

`quickjs-native` 和 `v8-native` 特性使共享运行时中的提供者能够运行。能力元数据反映了该运行时编译的提供者，包括由其他工作区消费者启用的特性。当共享运行时没有 V8 提供者时，V8 请求会报错 `ERR_ENGINE`；它们永远不会选择其他引擎。

运行时渲染器也由该宿主会话拥有。在`render.commit`之后，`renderer_backend()`会报告所选的后端，`has_native_surface()`会报告该帧是否到达了原生Skia光栅化表面。`render_snapshot_json()`会从该表面执行一次同步的RGBA8读回操作。原生呈现器可直接调用`render_snapshot()`以跳过JSON编码/解码；桌面烟雾测试会检查实际像素，而不仅仅检查功能元数据：

```bash
cargo test -p container-host-desktop --features window,skia-backend
```

这是一个离屏绘制表面/宿主循环的烟雾。它验证了 Skia 帧缓冲区提交和读回的边界；平台窗口、GPU 上下文和合成器仍需要相应的 macOS、Windows 或 Linux 集成运行时。

<a id="optional-desktop-development-window"></a>
## 可选的桌面开发窗口

`window` 特性添加了一个可选的 `DesktopWindowPresenter`，其基于 `winit` 和 `softbuffer`。它每次接受一个完整的 `RenderSnapshot`，因此开发模拟器可以重用相同的 `DesktopHost` 会话，并从其事件循环中呈现帧，而无需为每个节点调用桥接函数：

```rust,no_run
use container_host_desktop::DesktopWindowPresenter;
use container_render_skia::RenderSnapshot;
use winit::event_loop::EventLoop;

fn main() -> Result<(), Box<dyn std::error::Error>> {
let event_loop = EventLoop::new()?;
let mut presenter = DesktopWindowPresenter::new(&event_loop, "Weapp Container simulator", 375, 667)?;
// On WindowEvent::RedrawRequested:
let snapshot = RenderSnapshot {
    frame_id: 1,
    width: 375,
    height: 667,
    stride: 375 * 4,
    format: "rgba8-premultiplied".into(),
    pixels: vec![0; 375 * 667 * 4],
};
presenter.present(&snapshot)?;
Ok(())
}
```

事件循环仍由嵌入式应用程序拥有；它应将 `WindowEvent::Resized` 路由到 `presenter.resize(...)`，并在新的运行时帧之后请求重绘。呈现器是一个CPU软件绘制表面，不声明Skia GPU、DevTools、模拟器或设备一致性。通过以下方式显式构建：

```bash
cargo check -p container-host-desktop --features window
```

该仓库还包含一个一次性原生窗口烟雾，用于具有图形会话的机器：

```bash
pnpm host:desktop:surface -- --out artifacts/desktop/native-window-surface.json
```

它创建了一个真实的 `winit` 窗口，附加 `softbuffer`，呈现一帧固定的 RGBA 帧，并记录 `nativeSurface: true`、`presentedFrame: true` 以及一个像素的 SHA-256。其 `surfaceBackend` 为 `softbuffer-raster`，`gpuSurface` 保持为 `false`；CPU 窗口呈现无法满足 Skia/Metal/Vulkan GPU 门禁。在无头运行器上，报告为 `blocked`，这与通过原生窗口或运行时失败的情况不同。
