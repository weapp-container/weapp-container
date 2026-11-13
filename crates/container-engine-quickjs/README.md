# container-engine-quickjs

**简体中文** · [English](README.en.md)


稳定版 QuickJS 适配器边界，包含批量模块加载 API。默认 CI 构建使用显式元数据占位符，该占位符从执行方法中返回 `NativeBackendUnavailable`。启用 `quickjs-native` 以使用捆绑的 QuickJS-NG 运行时：

```bash
cargo test -p container-engine-quickjs --features quickjs-native
```

原生适配器应用内存/栈限制，安装中断处理程序，批量边界内评估 CommonJS 风格模块，使用 JSON 值批量调用全局或模块导出，并处理待处理任务。其启动程序暴露注册全局（`App`、`Page`、`Component`、`getApp`）和确定性的 `wx` 代理，用于存储、导航、定时器、能力检测和 `setData`。副作用被排队，并可通过 `QuickJsEngine::drain_host_events` 消费；宿主适配器应将这些记录通过正常的桥接/提供者边界路由。不支持的 API 返回结构化的 `ERR_UNSUPPORTED_CAPABILITY` 拒绝，并且永远不会静默执行无操作。运行时是线程相关的；宿主必须代理调用，而不是在不同线程间移动运行时。
移动端和 Harmony 目标可能需要 `rquickjs/bindgen` 以及平台 C 编译器，并由宿主工具链独立验证。

OpenHarmony 未捆绑 `aarch64-unknown-linux-ohos` 的 rquickjs 绑定；
在检查提供者时，请使用显式的目标特性及 SDK 工具链：

```bash
ohos_sdk_native="$OHOS_SDK/openharmony/native" \
  cargo check -p container-host-harmony \
  --features harmony,quickjs-native-harmony \
  --target aarch64-unknown-linux-ohos
```

仓库 `scripts/build-native-hosts.mjs` 命令提供了目标编译器、归档工具、bindgen的目标/系统根目录和宿主编译器变量，从而确保 QuickJS 不会意外地从宿主 ABI 绑定构建。

原生定时器使用共享定时器调度器，从宿主获取Unix毫秒时间。显式零值被保留；时钟必须是非负的安全整数。到期的定时器按截止时间顺序运行，若存在平局，则按注册顺序运行。每个回调都是一个独立的原生任务，在下一次回调前有一个Promise/微任务检查点，因此从回调或其微任务中取消操作将在下一次定时器之前生效。在一次轮询期间创建的定时器将等待下一次轮询，包括由Promise创建的零延迟定时器。逾期间隔会合并为每次轮询一个时钟滴答，并将其下一次滴答相对该轮询的时钟进行调度。

默认任务预算为每次轮询1000个回调；内部`__container_drain_timers`引擎调用的可选第二个参数可选择1到1000之间的预算。耗尽会发出`timer.yield`主机事件，并保留待处理的定时器以供下一次轮询使用。回调和`queueMicrotask`的异常会进入错误队列，且不会丢弃后续任务。延迟会被截断并限制在0–2147483647毫秒之间；截止时间在`Number.MAX_SAFE_INTEGER`处饱和。定时器回调会接收额外参数以及`globalThis`作为其接收者。此预算限制的是回调数量，而不是任意的同步JavaScript或无限的Promise链；主机仍拥有执行截止时间和中断权。
