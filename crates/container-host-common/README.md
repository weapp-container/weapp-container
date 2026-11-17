# container-host-common

**简体中文** · [English](README.en.md)


Web、桌面、Android、iOS 和 Harmony 的宿主侧共享边界。`HostSession` 验证并管理一个 `container-runtime::Session`，然后暴露 `start`、`lifecycle`、`dispatch`、`dispatch_batch`、`dispatch_json` 和 `dispatch_batch_json` 操作。

宿主 crates 将 `quickjs-native` 和 `v8-native` 的提供者特性传递给共享运行时。在未启用 `v8-native` 的构建中，V8 会话将出现 `ERR_ENGINE` 错误，而不是静默回退；默认的 QuickJS 路径在未启用 `quickjs-native` 之前仍仅作为协议层面的无界面边界。

`lifecycle_state()` 和 `lifecycle_sequence()` 将核心状态机暴露给宿主事件循环。加载的清单初始状态为 `Created`；只有在接收到 `launch` 的验收后，才会转为 `Active` 状态，而 `hide`/`show` 操作则分别报告为 `Background`/`Active`，无需在宿主中进行第二层页面栈操作。

`dispatch_json` 接受一个信封或标准的 `{"messages":[...]}` 负载；`dispatch_batch_json` 要求后者。两条路径在第一个消息进入运行时之前都会验证会话/协议和信封的不变性，然后序列化一个完整的响应批次，以便 WASM、JNI、Swift/Objective-C 和 ArkTS/N-API 适配器无需为每个节点执行 FFI 调用。该包装器是线程相关的；需要跨线程访问的宿主必须提供显式代理，并将运行时保留在其所属线程上。

`poll_timers(now_ns)` 消耗 **Unix 时间戳纳秒**。Rust 所拥有的超时使用 `SystemTime`，QuickJS/V8 定时器 JavaScript 调度基于 `Date.now()`；运行时将相同的轮询值转换为毫秒，供 JS 回调使用。RAF/Choreographer/显示链接时间戳、运行时时间以及会话启动以来的时间属于不同的时钟域，只能用于调度宿主泵。在轮询时采样当前系统时间，包括暂停后，而不是维持一个过时的启动偏移。JavaScript 调用者必须在乘以纳秒之前将整数毫秒转换为 `BigInt`，并检查 `u64` 限制；带有有符号 JNI 调用者还额外拒绝负值和超出 `Long` 范围的乘法操作。宿主控制挂起和回调节奏；此时钟契约本身并不建立定时器节流或等同于微信的后台语义。

对于已验收的位图帧，`render_snapshot_json` 返回一个包含 `frame_id`、尺寸、步长和紧密打包的预乘 `rgba8` 像素的 `RenderSnapshot`。当请求的快照不可用时，快照访问会报告 `NoRenderFrame`。明确的外部帧快照请求可以生成软件诊断像素；借来的观测数据则不能。被动读取不会初始化页面渲染器。这是位图和诊断接口。外部帧和原生 GPU 的呈现通过其自身的呈现器合约消费已验收的场景/帧数据，而无需经过正常的全页 CPU 位图读取/回传/上传流程。`capture_render_snapshot` 是一个明确的 CPU 诊断请求，不能证明宿主 GPU 的呈现。

`render_revision` 标识了已验收的 Skia 版本，与应用程序帧 ID 和浏览器文档呈现命名空间无关。后端名称和原生/GPU 绘制表面标志仅为观察值；呈现权仍需匹配运行时拥有的确认。

Canvas 2D 绘制表面具有独立的生命周期。在成功执行 `wx.canvas.draw` 后，`canvas_snapshot_json(canvas_id)` 会返回相应的 RGBA8 缓冲区；它永远不会替换页面快照。`reserve:false` 启动新的命令历史，`reserve:true` 在现有表面上演示。一个没有确定性实现的渲染命令在提供者响应之前会返回结构化渲染错误，并将该错误报告为成功。

Native callers 必须将每个输出槽初始化为 `{ data: NULL, len: 0 }`，并在重复使用前释放它。Rust 边界不会覆盖非空槽，而是拒绝它，从而防止 JNI、Swift 或 ArkTS 调用方意外重用活动结果时发生内存泄漏。

对于被动页面检查，`accepted_page_observation()` 会借取已接受的帧、渲染修订版、固定提交目标和缓存快照，而无需初始化 Skia 或复制帧/像素数据。`page_render_status()` 提供分配/后端/绘制表面的相关信息，Metal 构建提供了被动的 `has_metal_context()` 查询。未加载的宿主保持 `NotLoaded` 状态；快照 API 在请求的快照不可用时仍保持 `NoRenderFrame` 状态。`render_target_for_revision()` 会拒绝零值或过时的 Skia 渲染修订版，并返回该成功页面提交所固定的靶标，即使其他密度的帧已重新提交。这些观察结果并不能确立当前页面、输入、就绪或浏览器的呈现权限，提交目标也不是测量的帧缓冲区或 GPU/设备结果。明确的快照请求可以克隆或生成诊断像素；借取的观察结果永远不会这样做。
