<a id="desktop-native-surface-smoke"></a>
# 桌面原生表面烟雾

**简体中文** · [English](README.en.md)


此独立示例创建一个 `winit` 窗口，附加一个 `softbuffer::Surface`，呈现一个确定性的 2×2 RGBA 帧，并发出 JSON 报告。该示例旨在用于 macOS、Windows 和 Linux 机器，且具备可用的图形会话：

```bash
pnpm host:desktop:surface -- --out artifacts/desktop/native-window-surface.json
```

该报告记录了 `nativeSurface: true`，`presentedFrame: true`，像素 SHA-256 值和 `surfaceBackend: "softbuffer-raster"`。`gpuSurface` 保持为 `false`，因为软缓冲是一种 CPU 显示路径。空头环境被报告为 `blocked`，不应将其解释为 GPU 或设备通过。
