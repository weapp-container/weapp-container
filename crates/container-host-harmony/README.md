# container-host-harmony

**简体中文** · [English](README.en.md)


HarmonyOS ArkTS/N-API/FFI 宿主边界。ArkTS 调用者使用共享的
`load_manifest_json`/`dispatch_json`/`dispatch_batch_json` 批量边界。
`harmony` 和 `arkui` 是明确的集成特性；在宣传 Skia 光栅绘制表面之前必须启用 `skia-backend`。可选的 `skia-gpu-gles` 特性会绑定 ArkUI XComponent 提供的当前 EGL/GLES 上下文，并将其已提交的帧渲染到窗口帧缓冲区。默认构建是一个元数据占位符，不包含 DevEco、模拟器或设备验证。

`weapp_container_harmony_host_capabilities` 返回一个版本化的 JSON 报告，将编译后的 ArkUI/渲染器/提供者特性与当前会话分开。它在 ArkTS 适配器附加了真正的 GPU 支持表面之前，保持 `runtime.gpuSurface` 为 false；一个可移植的 Skia 渲染快照不是设备层面的证据。

`start_session` 和 `dispatch_lifecycle` 是面向 ArkTS 的生命周期辅助函数。示例的原生适配器拥有 XComponent 绘制表面的生命周期；Rust ABI 为该边界暴露了 `weapp_container_harmony_host_attach_gles_context`、`weapp_container_harmony_host_render_gles_framebuffer` 和 `weapp_container_harmony_host_detach_gles_context`。

`quickjs-native` 和 `v8-native` 特性支持共享运行时中的提供者。能力元数据反映了该运行时编译的提供者，包括由其他工作区消费者启用的特性。当共享运行时中没有 V8 提供者时，V8 请求会报 `ERR_ENGINE` 错误；它们永远不会选择其他引擎。对于 `aarch64-unknown-linux-ohos` 目标，使用 `quickjs-native-harmony`；它启用 rquickjs bindgen，并防止因缺少目标绑定而被误认为是宿主构建。

`cdylib` 导出 `weapp_container_harmony_host_new/free`、`weapp_container_harmony_host_load_manifest`、`weapp_container_harmony_host_start`、`weapp_container_harmony_host_dispatch_json`、`weapp_container_harmony_host_dispatch_batch_json`、`weapp_container_harmony_host_capabilities`、`weapp_container_harmony_host_render_snapshot`、`weapp_container_harmony_host_canvas_snapshot`、`weapp_container_harmony_host_poll_timers` 和 `weapp_container_harmony_buffer_free`；ArkTS/N-API 示例和 CMake 链接边界位于 `examples/hosts/harmony`。

`weapp_container_harmony_host_render_snapshot` 在完成一个 `render.commit` 后返回一个 JSON `RenderSnapshot`；ArkUI 可以批量上传其预乘 RGBA8 像素。

`weapp_container_harmony_host_canvas_snapshot` 通过 UTF-8 canvas id 读取独立提交的 `wx.canvas.draw` 绘制表面，从而使 ArkUI 在无需每次命令都调用 FFI 的情况下呈现页面和 Canvas 2D 图层。

对于固定演示，使用以下命令构建：
`node scripts/build-native-hosts.mjs --build --platform harmony --profile release --distribution-profile restricted-showcase --showcase-policy /absolute/policy.json --out /private/build.json`。
该命令会转发运行时的编译包/API策略，将其身份记录在capabilities中，并在实际的Rust库中进行验证。私有报告还会对两个N-API集成库进行哈希处理。发布版本的调试信息已被剥离，构建路径也已重映射。受限状态观察仅暴露给原生呈现所有者所需的会话/页面身份以及视图/渲染修订信息；页面数据、开发细节以及诊断页面/Canvas快照均不可用。完整分发保留其原有的API。
