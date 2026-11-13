# container-engine-v8

**简体中文** · [English](README.en.md)


此 crates 提供了两种明确的模式：

* 默认构建是一个元数据占位符，每个执行方法都会返回 `NativeBackendUnavailable`；
* `--no-default-features --features v8-native` 链接了固定版本的 `v8 =
  152.2.0`（rusty_v8）提供者，并在 V8 隔离环境中执行 CommonJS 模块。

模式之间没有回退。如果宿主请求 V8，必须在编译时启用 `v8-native`；否则，在加载任何模块之前将收到一个稳定的引擎错误。Rusty V8 在启用特性构建时会下载目标平台的发布归档文件。当归档文件必须来自内部镜像时，在可重现的构建环境中设置 `RUSTY_V8_MIRROR`/`RUSTY_V8_ARCHIVE` 和 `RUSTY_V8_ARCHIVE_SHA256`。

提供商将所有 JavaScript 执行保留在隔离线程中，并仅暴露批处理 `container_core::JsEngine` 边界。模块加载将源代码封装在 CommonJS `module/exports` 作用域内；通过 JSON 序列化单个值批处理并返回单个值批处理，避免每个节点的 FFI 调用。

原生定时器行为与 QuickJS 共享。宿主轮询提供以 Unix 毫秒为单位的非负安全整数，包括显式零值。由于定时器按截止时间及注册顺序运行；每个回调之后都会跟随一个原生 V8 微任务检查点，然后才会运行下一个定时器。在该检查点中取消定时器将立即生效。在轮询期间创建的定时器将等待到下一次轮询。逾期间隔会合并为每次轮询一个时钟滴答，并使用轮询的时钟来确定其下一个截止时间，因此迟到的轮询无法遍历遗漏的周期。延迟会被截断并限制在 0–2147483647 毫秒之间；截止时间的增加会饱和于 `Number.MAX_SAFE_INTEGER`。额外的回调参数和 `globalThis` 接收器将被保留。

每次轮询默认最多允许 1000 个定时器回调；内部 `__container_drain_timers` 引擎调用可接受一个可选的第二个参数（范围为 1 到 1000），以降低该预算。`timer.yield` 宿主事件会报告保留的积压情况。定时器/`queueMicrotask` 错误会报告，但不会丢弃后续工作。预算限制的是定时器回调，而不是任意的同步 JavaScript 或无限的 Promise 链：V8 的检查点会清空原生微任务队列，宿主仍需负责执行截止时间和中断处理。
