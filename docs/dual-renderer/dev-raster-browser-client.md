<a id="ticketed-raster-browser-primitives"></a>
# 有票位的位图浏览器原语

**简体中文** · [English](dev-raster-browser-client.en.md)


`examples/hosts/web-wasm/dev-raster-frame.mjs` 使用 4096 字节元数据限制、16 MiB 像素限制和 4096 像素物理边限解码二进制帧 v2。
它会将每个重复的身份和维度与嵌套的运行时票据进行对比。身份在整个比较过程中始终为标准十进制字符串，包括完整的 `u64` 范围。不可变的元数据不授予运行时权限。像素是直接对收到缓冲区的 RGBA 视图；解码器不会复制整个帧，也不会再次对颜色进行预乘。JSON 元数据在标准 `JSON.parse` 之后进行验证；这并非一个拒绝重复键或生成标准 JSON 的解析器。

`DevRasterPresenterClient` 在 `dev-raster-client.mjs` 中是一个可选的 Canvas2D 事务库。其嵌入的所有者必须管理实际的 SSE 连接、帧请求以及最终的绑定心跳握手。只有在匹配的最终心跳结果确认了确切的连接令牌和纪元之后，它才能调用 `setBinding({sessionId, pageId, configGeneration, clientId, epoch,
connectionToken})`。`preview-init`、全局预览元数据以及 HTTP 队列确认无法建立该绑定。这些原语不会修改普通的模拟器 UI、命令行界面或默认的同步 Raster 策略。

拥有者在开始每个帧获取之前调用 `captureFrameRequest()`，然后通过 `offer(buffer, originalCapture)` 和 SSE 桥接批处理调用 `receive(batch)`。捕获操作保留原始的本地绑定引用；即使其他网络值一致，延迟获取也无法采用更新的页面或连接令牌。它们是本地调度事实，而不是套接字权限或网络身份。新帧在入队前会禁用输入。单个 RAF 回调绘制最新待处理帧，然后请求 `dev.raster.presented`，使用原始票据和 `draw.endpoint = "canvas2d-raf-draw-return"`。只有在相关最终响应返回相同票据且 `inputEnabled: true` 时，输入才会被打开，而绑定和最新帧仍保持最新。该端点观察到 RAF 内部返回 Canvas2D 调用；浏览器合成器完成和屏幕呈现未被测量。

Raster 发送适配器仅接受 HTTP `{queued:true}` 入口回执 或传输失败。即使 HTTP 响应与票证完全匹配，也无法完成确认或输入请求。最终结果必须通过 `receive(batch)` 从嵌入所有者当前的实际 SSE 流中进入。该适配器返回其自身的不可变回执，而不是将原始 HTTP 对象传递给共享传输。这一 Raster 特有的边界保留了通用传输对完整 HTTP 响应批处理的遗留支持。

`events(events)` 使用已接受的原始票据、逻辑视口和捕获的连接绑定。发送微任务在传输前会重新检查捕获内容；它永远不会填充后继连接令牌。服务器必须在每个操作前独立重新验证实际连接、当前所有者和运行时票据。一个已排队的输入在后续断开连接之前可能已产生实际效果；取消不会保证将这些效果回滚。

在 EOF、EventSource 失败、宿主丢失或绑定失效时调用 `disconnect()`，在移除客户端时调用 `dispose()`。会话、页面、配置、宿主版本或令牌的变更将使待绘制、回执和输入失效。超时将禁用输入。`retryPresentation()` 允许显式有限重试，使用相同的发出票据和新的相关请求 ID；它永远不会启动自动重试循环。每个客户端最多保留活动和最新待处理帧引用。宿主仍需负责一个有界单次正在传输的帧获取器，并精确清理其自身的 SSE/浏览器资源。

节点合约涵盖帧、UTF-8 和整数边界、不可变票据、合并、排队/最终响应、过期工作、输入栅栏和清理。它们注入已提交的绑定，但不证明真实的套接字握手、浏览器渲染、GPU完成、性能或任何平台发布门禁。
