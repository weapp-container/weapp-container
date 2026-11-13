<a id="explicit-raster-preview-connection-manager"></a>
# 显式位图预览连接管理器

**简体中文** · [English](dev-raster-preview-manager.en.md)


`examples/hosts/web-wasm/dev-raster-preview.mjs` 导出用于显式配置的 `ticketed-raster-v1` 开发环境的 `DevRasterPreview`。它不添加 HTML 路由、静态资源注册、CLI 选项或默认策略变更。普通的模拟器仍然保持独立。

```js
const preview = new DevRasterPreview({ canvas, onState, onDiagnostic })
preview.connect()
// Explicit ownership transfer, only after confirming this actual connection:
await preview.claim()
// The caller owns input listeners and sends logical-coordinate event batches:
await preview.events(events)
preview.dispose()
```

`connect()` 同步返回管理器；在被销毁或事件源构造失败时，可能同步抛出异常。`disconnect()` 也是同步操作。`claim()` 和 `events()` 返回承诺。`dispose()` 会关闭其终端屏障并同步释放所拥有的资源；该操作是幂等的。通过承诺规范化错误的调用者应在其内部调用 `Promise.resolve().then(() => preview.connect())`，或使用 `try`/`catch`。

`onState` 投影包含 `phase`、`clientId`、`connected`、`owner`、`inputEnabled`、`sessionId`、`pageId`、`configGeneration`、`previewEpoch` 和 `presentationTicket`。它从不发布私有连接令牌。阶段包括 `connecting`、`waiting-init`、`confirming`、`owner`、`readonly`，呈现器的绘制/ACK 阶段，`disconnected`、`error` 和 `disposed`。`connected` 识别一个被拥有的活跃 EventSource 实例，而不是声称其私有初始化或心跳已完成。`owner` 本身不授予输入权限：`inputEnabled` 仍取决于最终的呈现 ACK。只在镜像 RAF 绘制返回后才投影只读的 `presentationTicket` 元数据，因此页面可以区分逻辑 CSS 尺寸与物理像素尺寸。此投影不授予任何拥有绑定或输入权限。

<a id="actual-connection-and-final-heartbeat"></a>
## 实际连接和最终心跳

每次 `connect()` 都会创建一个实际的 EventSource，位于 `/api/events?clientId=...&since=0`。每个监听器捕获该源的本地连接对象。替换它将移除其监听器，中止其请求，并关闭该特定源。旧的初始化、预览、最终桥接、错误和网络回调无法作用于其后继者。EventSource 出现错误时会关闭并冻结该实例；重新连接需要另一个显式的 `connect()`，并使用另一个私有令牌。管理器不会让一个不透明的 EventSource 静默地自动重连并保留其之前的权限。

连接私有 `preview-init` 必须具有版本 1.0，该 `clientId`、`connectionToken` 和 `committed:false`。它不包含owner epoch。初始化、公共预览状态、HTTP202 队列确认和另一个客户端的最终响应均不能确立权限。管理器会向 `POST /api/preview` 发送绑定的心跳，保留原始令牌和捕获的公共 epoch。只有与原始 `requestId` 匹配的最终响应，带有自身的 `clientId`、`ok:true`、实际连接/令牌不变且心跳 epoch精确匹配，才能确认绑定。令牌从不被解析以获取内部序列号。预览 HTTP 响应必须是针对该原始请求的队列确认。即使存在相关联的 `ok:true` HTTP 响应体，也会被拒绝为协议错误；它永远不会进入最终预览通道。该通道仅由实际当前 EventSource 上的监听器提供。

`GET /api/state` 必须通告精确的开发者配置和项目信息，原始 `devRaster.binding:{sessionId,pageId,configGeneration}` 和公共 `preview` 状态。状态请求按顺序执行。重放的 SSE 状态/预览体仅请求新的 GET；它们不会用保留的历史数据覆盖当前页面或会话。不同的页面、会话、配置、预览纪元、所有者或过期时间将冻结旧的呈现器、捕获和输入。帧顺序比较仅限于当前绑定域。

心跳和状态请求具有本地超时和有界的重试预算。
初始握手失败会短延时后重试；预算耗尽后将关闭所拥有的 EventSource。正常的心跳续期在请求待处理期间保留相同的证明和已接受的呈现器绑定，而失败的续期会在重试前冻结输入。正常成功的续期不会合成视图变更、重复业务评估，或创建另一个权威身份。显式声明使用相同的绑定预览端点，然后需要一个新的最终心跳才能激活相应的所有者绑定。镜像不会自动声明。
心跳间隔加上两个请求超时必须能容纳在已宣传的租约内，需考虑上一次最终响应延迟和下一次续期超时。不安全的定时配置将被明确拒绝。

每个实际最终也会提交一个保守的本地截止时间，该截止时间由发送前从控制请求的时钟样本计算得出，并加上通告的租约持续时间。原始运行时的实际租约仍然具有权威性；本地截止时间只能提前停止输入。`owner`、`inputEnabled`、帧准入、镜像 RAF 和桥接发送回调检查超时时间同步进行，因此暂停的定时任务在恢复时不会留下过时的输入启用状态。一个在自身截止时间之后才到达的延迟最终无法延长其截止时间。未改变的 `expired:false` 状态或有限的时钟样本无法使已过期/被拒绝的本地证明恢复；必须有另一个实际最终来实现。正常及时的续租更新本地截止时间，而不会替换已接受的证明或呈现器绑定对象。

可注入的 `clock` 默认为 `Date.now()`，必须返回有限的、非负的经过毫秒数，并在该文档的定时器队列暂停期间持续递增。逆向或无效的观察将拒绝当前本地租约，直到新的实际最终值建立另一个保守截止时间。该时钟是嵌入式输入，与虚拟小程序业务定时器分离。本地拥有的过期定时器会主动冻结和续期，而获取者/发送者则独立于该定时器的执行。页面仍拥有其可见性/BFCache策略；此本地保护机制不声称精确的服务器时钟或物理屏幕完成。
`onState` 是一个通知快照，因此在定时器和事件任务暂停期间，面板可以继续显示其最后的投影。它在下一次通知时刷新；它本身不会提供输入。同步的 `owner`、`inputEnabled` 和 `events()` 门控在被调用时立即拒绝已过时的证明，包括在下一次 UI 更新之前。

<a id="frames-readonly-mirrors-and-input"></a>
## 帧、只读镜像和输入

管理器拥有一个逻辑帧获取槽位和一个最新的待处理请求。拥有者在发送前调用 capture `presenter.captureFrameRequest()`，并将该精确的捕获传递给 `offer(buffer,capture)`。仅接受声明了 MIME 的 binaryv2。实际源、本地权威、已确认证明或拥有者角色发生变更的响应将被丢弃。A404 表示没有当前帧；其他快照通知可再次请求它。所有获取操作均使用 `AbortSignal`；如果注入了忽略取消的自定义传输，它可能继续其底层工作，但其延迟结果无法提供或授予输入。这并不对任意忽略取消契约的传输提供资源释放保证。
临时帧失败也具有有界的重试次数。每次重试都会明确恢复相同的已确认呈现器绑定，然后再捕获新的请求；它不能依赖于偶然的后续状态或心跳通知。

所有者使用 `DevRasterPresenterClient` 进行解码器/RAF/精确回执/输入栅栏操作。
SSE `bridge` 会批量传递其原始的 `SseBridgeTransport.receive`。事件批次会立即传递给呈现器，并捕获其已验收的票据，在API入口处绑定；管理器从不等待，而是用新的票据覆盖旧输入。

一个已确认的镜像使用独立解码器和一个单独的有界 RAF 时槽。它的字节必须命名当前会话/配置和公共所有者时钟/ID。它在不创建所有者绑定的情况下显示像素，调用 `setBinding`、发出 ACK 或启用输入。其 RAF 回调会再次检查本地捕获的精确内容。镜像和所有者绘制仅观察 Canvas2D 绘制返回值；二者均不声称合成器或物理屏幕完成。

`disconnect()` 和 `dispose()` 中止状态、帧和控制请求；取消所拥有的心跳/重试/超时任务以及镜像 RAF；终止呈现器的等待和输入；移除监听器并关闭所拥有的数据源。处置会在调用回调之前关闭终端屏障。它不会关闭其他无关的浏览器标签页、窗口、服务器或数据源。嵌入页面仍拥有其输入监听器、页面/BFCache 策略以及任何其他 UI 资源。

<a id="validation-boundary"></a>
## 验证边界

节点定义使用注入的 EventSource、fetch、clock、presenter 和 RAF fixtures。它们涵盖连接/最终响应的相关性、过时工作、只读镜像、显式声明、重试边界和清理。它们不能证明真实的 TCP 握手、真实的浏览器绘制/输入、连续手势、合成器完成、GPU 性能、七宿主兼容性或目标完成。该编写的候选者本身并未由其作者执行；根节点拥有测试/编译/浏览器通道，并单独记录精确执行。
