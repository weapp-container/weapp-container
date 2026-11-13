# container-host-android

**简体中文** · [English](README.en.md)


Android NDK/JNI 宿主边界。`load_manifest_json` 和批量 `dispatch_json` 是 JNI 调用者与运行时之间的共享边界。`android`、`gles` 和 `vulkan` 是明确的集成特性；要么 `skia-backend`，要么实际的 `skia-gpu-gles` 特性会宣告编译后的 Skia 边界。默认元数据占位符适用于协议测试，不声明模拟器或设备的合规性。

`build.nativeSurface`/`build.renderer` 描述编译边界。在首帧提交前，它们可能报告 `skia-raster`；`runtime.gpuSurface` 保持为 `false`，直到宿主拥有的 GLES 上下文和帧缓冲区接收到一帧。

`weapp_container_android_host_capabilities` 返回一个版本化的 JSON 能力报告。
`build` 描述了编译特性及提供者，而 `runtime` 报告当前加载的会话和已提交的绘制表面。`gpuSurface` 直到 Android 驱动器连接了真实的 GLES/Vulkan 上下文之前都保持为 false；仅能读取 Skia 绘制快照，并不能作为 GPU 证据。

`start_session` 和 `dispatch_lifecycle` 可供 JNI 适配器使用，因此应用的启动顺序与 Web 和桌面宿主保持一致。

`quickjs-native` 和 `v8-native` 特性使共享运行时中的提供者能够运行。能力元数据反映了该运行时编译的提供者，包括由其他工作区消费者启用的特性。当共享运行时没有 V8 提供者时，V8 请求会报错 `ERR_ENGINE`；它们永远不会选择其他引擎。

`cdylib` 导出 `weapp_container_android_host_new/free`，`weapp_container_android_host_capabilities`，`weapp_container_android_host_load_manifest`，`weapp_container_android_host_start`，`weapp_container_android_host_dispatch_json`，`weapp_container_android_host_dispatch_batch_json`，`weapp_container_android_host_render_snapshot`，`weapp_container_android_host_canvas_snapshot`，`weapp_container_android_host_poll_timers` 和 `weapp_container_android_buffer_free`；对应的头文件和 JNI 所有者位于 `examples/hosts/android`。

`weapp_container_android_host_render_snapshot` 在完成一个 `render.commit` 后返回一个 JSON `RenderSnapshot`；其像素数据为单个 GLES 或 Vulkan 上传操作的预乘 RGBA8 格式。

`weapp_container_android_host_canvas_snapshot` 通过 UTF-8 canvas id 读取独立提交的 `wx.canvas.draw` 绘制表面。它将页面和 Canvas 2D 表面分开，同时在 JNI 之间传输完整的 RGBA 快照。
