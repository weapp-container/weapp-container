<a id="weapp-container-c-abi-v1"></a>
# Weapp 容器 C ABI v1

**简体中文** · [English](README.en.md)


公共合约为 `sdk/contract/include/weapp_container_sdk.h`。Rust 库可将 `weapp_container_sdk` 编译为静态库、动态库和 Rust 库。默认特性使用真实的 QuickJS 引擎和 Skia 像素后端。Android 用户需添加 `quickjs-native-android,skia-gpu-gles`；iOS 用户需添加 `quickjs-native-ios,skia-gpu-metal`。macOS Metal 使用 `skia-gpu-metal`。显式使用 `--no-default-features` 构建对 ABI 传输测试有用；它不是一个可分发的渲染器/引擎实现。

会话调用保持在创建原生线程上。API 在访问运行时状态之前会拒绝外来线程。平台包装器应将工作排队到该拥有线程，并在命令边界之上提供带类型的安全 Kotlin、Swift、Dart 或 TypeScript API。在执行命令之前会拒绝已占用的输出缓冲区。所有结果缓冲区都必须显式释放。

一个获取的帧独立于会话拥有不可变的预乘RGBA8字节。保留/释放允许平台合成器在另一个线程消费帧，包括会话关闭之后。既不释放帧，也不读取其元数据会触发运行时或GPU上下文。

在关闭会话之前，应分离原生绘制表面。在发生 GLES 上下文丢失后，应在拥有线程上使用 `gles_abandon`，而不是尝试在不存在的上下文中删除资源。Destroy 接受调用方句柄槽的指针，在成功时清除该指针，从而实现幂等清理。失败时保持槽不变。每个构建中都存在 GPU 入口点，当后端未编译时，它们会返回结构化的不支持错误。

`cargo test -p container-sdk-ffi --locked` 运行传输/线程/帧测试
并在 Unix 系统上编译、动态链接并执行一个真实的 C 消费者。
该 C 程序引用了每个公共函数，加载已验证的 Android 移动版包，获取其渲染帧，并在销毁会话后读取该帧。另一个独立测试会将动态符号表与头文件进行对比，因此仅通过解析头文件文本无法通过声明/导出漂移检测。跨平台发布消费者还必须在其目标平台上额外测试打包的静态/动态库。
