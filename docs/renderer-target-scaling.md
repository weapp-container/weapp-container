<a id="logical-frames-and-physical-render-targets"></a>
# 逻辑帧和物理渲染目标

**简体中文** · [English](renderer-target-scaling.en.md)


已提交的渲染树使用 `RenderFrame.viewport` 中的逻辑尺寸。
宿主拥有的 GLES 帧缓冲区和 Metal 可绘制纹理提供物理像素尺寸。两种适配器都通过相同的 `draw_frame_to_target` 辅助函数进行绘制，该函数将每个轴的尺寸按物理目标尺寸除以逻辑视口尺寸进行缩放，然后恢复画布变换。

在 Retina 显示屏上需要这样做：通过一个 1125 像素的可绘制区域呈现一个 375 点的视口，需要一个 3 倍的变换。使用单位变换绘制会将页面放置在该可绘制区域的左上角三分之一处。独立的 X/Y 比例还能处理在调整大小过程中目标的宽高比发生变化的情况。逻辑维度为零时会清除目标而不进行绘制；正的分数维度将按提供的值使用，而不是被限制为 1。

回归测试在 CPU Skia 绘制表面上调用此共享绘制辅助函数，并读取实际的 RGBA 像素。四个彩色象限必须在 2×、3×、非均匀缩放以及分数视口尺寸下，每像素都完全填充。随后的一个 1 像素物理标记用于检查辅助函数恢复其变换。另一个独立测试检查空视口的行为。

```bash
cargo test -p container-render-skia --features skia-backend --locked native_target_scaling
```

这些 CPU 光栅化测试验证了坐标变换和读取回显。它们并不能证明 GPU 执行、可绘制内容的呈现、截图等效性或设备行为；这些需要相应的宿主证据。
