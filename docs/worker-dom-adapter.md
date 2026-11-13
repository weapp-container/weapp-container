<a id="worker-dom-scheduler-adapter-candidate-contract"></a>
# 工作区 DOM 调度器适配器（候选合同）

**简体中文** · [English](worker-dom-adapter.en.md)


`WorkerDomAdapter` 实现了七个异步呈现调度器钩子，作用于已加载的浏览器 Worker。它使用实际的 `WorkerBridgeTransport`、`DomSessionClient` 以及严格的 `DomViewPresenter` 事务路径。它不会创建 JavaScript 运行时、在本地求值模板、合成运行时回复，或关闭其借用的 Worker。此有限的适配器在本次补丁中未连接到产品入口。

<a id="ownership-and-construction"></a>
## 所有权和构造

构造函数需要 `rpc` 和实际完成的 `loadResult`。Load 必须协商精确的有序观察契约 `1.0`，选择 `browser-view`，宣传 QuickJS，并确认相同的 worker epoch/session 和已验证的 pack-index SHA-256。可移植的路由/样式图被复制为受限的冻结plain数据。渲染器替换和不匹配的 pack 所有者是明确的失败。

适配器拥有一个空闲的 DOM 呈现器及其回调连接。除了精确的严格释放合约 `1.0` 之外，Worker 呈现器必须暴露 `inputGuardContract()`，返回恰好为 `{ version: "1.0", synchronous: true, durable: true }`。适配器在创建其传输或连接客户端回调之前会验证此能力；缺少、异步、非持久或未知的合约将抛出 `ERR_PROTOCOL_VERSION`。这是一个独立的 Worker 能力：通用的 `DomSessionClient` 严格释放 `1.0`、旧版全呈现以及明确的旧版分段 API 并不要求该能力。仅传递可选的 `confirmAsync(..., { inputGuard })` 参数本身并不能协商支持。

持久合同意味着同步布尔守卫会附着于已确认的条目上，在激活前后都会被检查，并参与之后每一个事件和几何体进入。守卫失败会冻结权限；它不会撤回真实的回执，也不会解决资源屏障。它涵盖了在前驱清理期间普通所有者的退休以及重入激活钩子的情况。

默认情况下，它拥有一个桥接器，该桥接器位于一个作用域观察的 RPC 包装器之上；该包装器在对应的内部桥接器结果之前处理每个原始的有序观察。宿主必须及时将未请求的 Worker 事件转发到 `adapter.receiveEvent(message)`。该入口不会等待呈现、授予权限或 ACK 事件的回执；`WorkerRpcClient` 本身拥有其事件信用回执账本。

对于一个包裹的 `WorkerWebSession`，传递其唯一预先创建的 `bridge`。该桥接必须使用相同的提供的 `rpc` 对象，并匹配会话/纪元。提供的 RPC 必须是拥有者的观察感知包装器：成功结果、错误详情和延迟回复必须在桥接内部相关之前传递原始的有序观察。拥有者将原始观察转发到 `adapter.receiveObservation`，然后将每个未请求的批次恰好一次传递到该单个 `bridge.receiveBatch`。不要在此共享拥有者路径中同时调用 `adapter.receiveEvent`。对同一原始序列的重复转发是无操作的；接收方不会重新编号到达顺序。为了仅交付一次效果，拥有者应使用其自身的批次回调，并保持 adapter `onBatch` 未设置。

在借用桥模式下，`DomSessionClient` 接收一个非所有权的前端。关闭适配器会消耗其候选/呈现器/对象 URL，但不会断开、重连或销毁该共享桥。所有者必须按此顺序关闭：调度器（它等待每个适配器飞行/释放），适配器，共享桥，然后是 RPC。适配器永远不会调用 `rpc.close`、`Worker.terminate`、全局关闭或与之无关的资源清理。

`onObservation` 和 `onBatch` 必须是同步的。等待 Worker 事件回调中的呈现会占用事件信用，可能导致实际完成呈现的操作死锁。诊断回调失败不能授权输入或资源释放。独立的事件入口会冻结并报告失败，而不是将其抛入借用的 RPC 事件回调中。

在独立模式下，外部错误可以保留一个真实的原生批次，位于 `details.batch`、`details.committedResult` 或嵌套的 `originalDetails` 中。适配器首先消费原始的外部观察值，冻结输入，并将每个保留的批次作为效果/证据通知发送到 `onBatch`。这些错误通知**不会**调用桥接器的 `receiveBatch`：一个成功的内部最终结果无法将公共操作的外部失败转为成功。原始错误仍然会被抛出，且延迟的错误最终结果无法复活已退场的请求或输入。如果观察验证或通知回调失败，原始错误仍将保留，并附带清理失败。借来的桥接错误通知仍由外部所有者单独负责，避免了效果的重复传递。Worker 的 `fault` 事件会保留其真实的嵌套 `payload.error.code` 和 `payload.error.message`。

故障诊断文本完全保留，而不是接收 `DomViewError` 的本地消息前缀。原始观察结果仍会首先进行处理；验证或观察回调失败会被附加到真实故障上，作为清理证据，且无法清除该故障。故障处理仍保持输入冻结状态，从不会将一批数据发送给桥接相关性。之后的正常观察不会清除适配器的故障状态，也不会授权使用旧的输入绘制表面。

<a id="scheduler-methods"></a>
## 调度器方法

| 方法 | 边界 |
| --- | --- |
| `prepareTemplate(demand, context)` | 捕获不可变的拥有者/页面/视口/硬性生命周期，然后使用生成的页面资源调用实际的严格 `client.prepareTemplate`。仅返回实际准备过程的冻结消耗输入证明。 |
| `preparePaint(demand, accepted, context)` | 显式拒绝 `ERR_UNSUPPORTED_CAPABILITY`。未协商保留的 DOM 绘制发布；无法将其作为回退方案重新评估视图。 |
| `present(candidate, context)` | 需要精确的无透明所有权句柄和匹配的归一化证明。只有在实际运行时许可、DOM 交换、精确的运行时最终确认以及严格的异步呈现器确认之后，才会返回确认状态。 |
| `release(candidate, context)` | 稳定的精确候选 Promise。即使调用上下文存在错误，也会在拒绝前清理已知资源。使用实际客户端确认和严格的释放结果，从不会将调度器的 `committed:false` 作为回滚权限。|
| `freezeInput(reason)` | 同步禁用客户端的已接受输入和呈现器监听器。不提供确认。 |
| `cancelOwnedWork(reason)` | 稳定的 Promise，已在重入回调之前声明。中止所拥有的尝试，冻结输入，并执行真正的保留控制通道 `view.retire`。 |
| `dispose()` / `close()` | 一个稳定的 Promise。等待取消和严格的客户端/呈现器销毁，然后检查所有已拥有的资源租约。不会关闭借来的 Worker 或借来的桥接器。 |

每项准备必须包含 `scheduling.version: "1.0"`，一个精确的发布密钥，以及非空的生成页 `consumedInput`。页面、路由和视口必须与需求匹配，实际消耗的模板版本必须至少等于捕获的需求版本。证明永远不会从 `documentRevision`、最新观测值、HTTP/Worker回执、排队响应或ACK时间状态中重建。缺少准备事实将导致失败和清理。

一种更新的软观察可以在真实准备过程中推进期望的模板状态。候选者保留其原始消耗的修订版本，使调度器能够合并后继版本。`DomSessionClient` 的权限使用硬性 `surfaceGeneration`，**而不是**观察序列。页面/视口/生命周期/后端替换会作废旧的硬键并冻结其输入。严格呈现器确认的结果（包括 `inputEnabled:false`）仍然具有权威性。如果在精确运行时回执（包括来自就绪状态回调）之后权限被作废，严格 `presentPrepared` 将返回该真实最终状态（输入已禁用）并保留已验收的资源，直到其实际最后一次使用。在回执之前作废仍会拒绝，中止未确认的键并清空其候选/资源清理；这两个边界分别处理。

<a id="resource-last-use"></a>
## 资源最后使用

资源通过其完整的实际 DOM 显示键和 SHA-256，通过真实的 Worker `resource` 操作进行请求。适配器在创建 blob URL 之前，会验证返回的完整键、哈希值、附加的 ArrayBuffer 长度以及本地计算的 SHA-256。现有的 DOM proifle 支持 PNG、JPEG、WebP 和 GIF 图片；不支持的资源类型将保持明确的失败。此补丁不引入字体解码、HTTP 降级或无界限的共享资源缓存。

每个资源限制为 16 MiB，总和默认值为 64 MiB 和 1024 个活动租约（配置可能降低这些限制）。预算在请求前预留。每个已接受的 URL 都有一个稳定的发布承诺，并且最多被撤销一次。原始严格呈现器拥有其解码器/人口/释放器的最后使用；适配器不会在调度器释放时立即撤销已接受的 URL，也不会在清理截止时间前强制撤销它们。URL 创建之后的延迟取消会在此前释放该确切的 URL。撤销失败将保留租约、字节和失败信息；存在待处理的严格清除或剩余租约将阻止成功关闭。

`view.retire` 是在已进入 WASM 工作之后的真实有序原生控制屏障。它并不声称会中断当前正在执行的同步 WASM，停止借用的 Worker 的业务定时器或卸载其包。其外部拥有者负责最终的 Worker 关闭。精确键 `view.abort` 的清理操作在桥接/RPC 关闭前仍然可用。

<a id="scope-and-validation"></a>
## 范围和验证

accompanying test draft 组成了实际的 RPC、桥接、客户端和呈现器代码，围绕一个明确的假 Worker/原生响应器和假 DOM 候选者。它涵盖了证明时间、错误/排队的确认、观察顺序、强制失效、精确句柄、资源哈希/预算、异步最后使用、撤销失败和借用所有权。这些只是合同单元测试。

没有进行测试，未执行 JavaScript 代码，未构建，未创建浏览器会话或设备检查，候选作者未运行任何测试。根代理拥有集成、测试执行以及相关证据的控制权。产品入口连接、真实的 WASM 包加载、真实的隔离 DOM 文档、浏览器 GPU、负载下的工作线程定时器、七个宿主适配器，以及性能/接近等效的验收仍为独立的审核环节。仅绘制协商的故意缺失必须保持可见。
