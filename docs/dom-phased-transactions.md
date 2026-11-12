<a id="dom-phased-transactions-and-resource-release-contract"></a>
# DOM 阶段性事务和资源释放协议

**简体中文** · [English](dom-phased-transactions.en.md)


这是一个本地事务 API，独立于 Worker 调度器的连接。它不声明浏览器、GPU、宿主、性能或官方微信验收。

<a id="split-api"></a>
## 分离 API

```js
const prepared = await client.prepareTemplate(render, { signal, hostContext })
// No runtime permit, local swap, final ACK or input activation has occurred.
try {
  const result = await client.presentPrepared(prepared)
  // Real runtime ACK followed by exact local async confirmation.
} finally {
  await client.releasePrepared(prepared)
}
```

一个事务可以被拆分为多个部分，直到它被呈现或显式释放为止。
`prepared` 是一个精确的冻结的无透明客户端所有对象，包含 `key`、`releaseMode` 和可选的复制 `scheduling`。处理副本或由其他客户端拥有的句柄将被拒绝。`presentPrepared` 消费一个句柄一次。

`releasePrepared` 返回一个稳定的承诺。在运行时确认之前，它会中止本地候选并请求运行时中止精确键。在真正确认后，它会保留已接收的图像和资源租约，直到被替换或关闭。结果为 `{released:true, acknowledged, remoteAbort, resourceBarrier}`。`remoteAbort` 区分 `confirmed`、`not-required`、`not-prepared`、`unavailable` 和失败。不可用的远程清理不构成确认。

信号中止，权限失效，断开连接并处置空闲分片
在同一个串行通道上工作。释放失败将被拒绝并达到诊断。
调度器必须在拒绝时发生故障；它不能将诊断视为清理操作。
运行时回执不可逆：清理无法撤销应用的影响，且当本地确认失败时，已接受的图像将保持非交互状态。

<a id="strict-default-versus-legacy-compatibility"></a>
## 严格默认值与传统兼容性

拆分准备默认值为 `releaseMode:'strict'`。在任何运行时请求或替换副作用之前，客户端会验证这些呈现器方法：`candidateReleaseContract`、`releaseCandidate`、`drainCandidate`、`confirmAsync`、`disposeAsync` 和 `drainDisposal`。

精确的版本化描述符是：

```js
{version:'1.0', exactHandle:true, pendingAcquisitions:true,
 asynchronousDisposal:true, asynchronousConfirmation:true,
 asynchronousShutdown:true}
```

类身份或声明的描述符本身不授予任何权限。必须存在相应方法，并且释放/确认/关闭结果需精确匹配字段集、版本、持有的句柄、密钥、回执/呈现器身份以及已确认状态。

现有的构造函数用法以及完整的 `client.present(render)` 便捷方法
仍与以前实现同步事务 API 的旧式呈现器兼容。显式拆分 `{releaseMode:'legacy'}` 也是允许的；其结果会报告 `resourceBarrier:'legacy'`。布尔值 `presenter.abort()` 和同步 `presenter.dispose()` 保持原有的返回行为。这些旧式方法无法建立异步资源释放屏障。

<a id="exact-presenter-contract"></a>
## 精确的呈现器合约

`releaseCandidate(handle,{resumePrevious:false,timeoutMs})` 仅接受原始的呈现器拥有的候选句柄，并返回一个稳定的承诺。它在重新进入资源回调时仅记录一次释放。成功结果具有完全相同的格式：

```js
{version:'1.0', handle, key, status:'released' /* or 'retained' */,
 cleanupPending:false}
```

`drainCandidate(handle)` 提供了底层的实际无界 drain。它包括原始候选创建、计划/资源准备和数据填充承诺，以及它们产生的所有延迟销毁工作。返回的拒绝清理承诺仍可观察；仅无操作的拒绝观察者仅防止未处理的拒绝噪音，并不会将失败转为成功。清理 drain 会收敛到一个固定点，而不是仅停留在已可用工作的一次快照上。即使已返回布尔型中止，同步销毁错误仍会被记录。

计划保留同步 `dispose()` 以保证兼容性。`disposeAsync()` 是一个共享的单次独占租赁屏障，包括租赁释放返回的 Promise。候选处置可能为同步操作，或返回错误数组的 Promise 或空值。可选的候选 `disposeAsync()` 也会被等待。呈现器拥有的计划释放屏障可防止同步委托 `plan.dispose()` 在异步候选处置完成前撤销租赁。实际的计划释放，包括同步错误，将在最后一次使用屏障之后执行。

清理首次请求的可选候选 `cancel()`，并冻结/隐藏候选，然后等待原始的批量操作完成，再调用其释放器。一个忽略取消的自定义候选会保持实际的流持续进行；呈现器在仍存在最后一次使用时无法撤回其计划。候选的释放不得在其自身释放器内部等待呈现器拥有的 `plan.disposeAsync()`：这样做会反转所有权依赖关系，并保持一个待定超时，而不是一个已声明的成功释放。

内置浏览器提供程序在帧销毁前取消并结算其自身的 RAF 承诺。取消操作终止了等待浏览器全局字体就绪的本地延续，但不声称全局字体集已完成。它移除图像 `src` 以请求解码器取消，保留实际的原始解码器承诺，并在这些承诺结算前保持帧/租约所有权。移除图像源并不能证明解码器已结算。一个从未结算的解码器会留下待清理任务；有限超时会使其可观察。提供程序单元的模拟测试是辅助证明；实际浏览器测试是另一个由根拥有控制的入口。

`confirmAsync(receipt,{inputEnabled,timeoutMs})` 需要原始精确的提交收据。它不可逆地确认且禁用输入，撤回前代，等待实际前代资源释放，然后才启用输入并接受初始几何形状。它从不采纳由旧版同步 API 之前确认过的呈现。如果前代出现故障，则保留新的确认图像，报告失败并保持输入冻结。

其成功的结果正是：

```js
{version:'1.0', handle, key, receipt, inputEnabled, cleanupPending:false}
```

`disposeAsync({timeoutMs})` 在任何同步回调之前声明一个稳定的承诺。它会放弃并清除所有跟踪的拥有条目，包括可能被抛出的旧式回调所跳过的条目。成功的精确结果为 `{version:'1.0',presenter,status:'disposed',cleanupPending:false}`。客户端在呈现器屏障之后关闭其传输；即使该屏障失败，它仍会关闭传输。`drainDisposal()` 在关闭开始后暴露实际的关闭工作。

<a id="timeout-and-failure-semantics"></a>
## 超时和失败语义

一个有边界的释放/确认/关闭操作可以使用 `releaseOutcome.cleanupPending:true` 拒绝 `ERR_TIMEOUT`。即使后续清理完成，该确切的承诺仍保持被拒绝状态。超时并不能证明资源已释放。请调用实际的 drain API 来观察最终的成功或失败；绝不要仅仅因为定时器过期就重新打开输入。如果提供者忽略取消操作，可能会导致实际工作无限期地等待。严格的准备清理失败会将实际的 `cleanupDrain` 和清理错误附加到准备失败中。

一个呈现器会追踪返回给它的资源和承诺。它无法证明提供者分配并从未返回的隐藏资源已释放。为关机保留的失败目前是无界限的诊断信息，而不是性能验收声明。该候选方案不验证不可信的自定义呈现器实现内部细节，不连接 Worker 产品适配器，不实现仅绘制的 DOM 重用，也不在其他宿主中建立 GPU/呈现完成。

<a id="validation-ownership"></a>
## 验证所有权

集成实现将本地 Node、原生和独立无头呈现器的结果保留在[呈现合同归档](archived-evidence.md)中。
根所有权的不可变验证监督者记录了每次运行的精确源映射和原始结果。相关测试入口点包括 `dom-session-client`、`dom-presenter`、`worker-bridge-transport`、`remote-dom` 和 `simulator-dom-client`。这些重叠检查并不能确立实际的 Worker 产品入口。产品浏览器证据仍是一个独立的审查环节。
