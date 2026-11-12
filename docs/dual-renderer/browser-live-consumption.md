# Live Document 2.1 显式消费

这是独立、显式开启的开发协议扩展。默认 `DomLiveSessionClient` 仍使用 2.0，
普通模拟器 CLI 和 Worker 产品入口仍使用各自原协议。2.1 不提供原生编辑 lease，
也不授予中文 IME、硬件 GPU、七宿主或性能验收通过。

## 协商与请求身份

客户端传入 `liveVersion: '2.1'`，发送 `view.live.enable`，payload 为
`{"version":"2.1"}`。外层 bridge 保持 `protocolVersion: "1.0"`。
运行时使用系统熵发行 128 位 lane；熵不可用时明确报错。成功 contract 增加：

```json
{
  "version": "2.1",
  "requiresOwnerReplacementWhenFull": false,
  "transactionRetention": {
    "version": "1.0",
    "laneId": "runtime-issued-opaque-lane",
    "firstSequence": "1",
    "explicitConsumption": true
  }
}
```

其他 contract 字段保留，包括 `nativeEditing:false`。enable 的原 envelope 和
完整外层 final 单独保留一次；相同请求仅重放原结果，不能重新发行 lane 或改换
profile。协商元数据上限为 8 KiB，协商 final 上限为 512 KiB。

prepare、permit、presented、abort 的 payload 使用 `version:"2.1"`，并增加
`transaction:{laneId,sequence}`。sequence 是从 1 开始的规范十进制 u64 字符串，
requestId 必须精确为 `live:<laneId>:<sequence>`。新 admission 只允许最高已接纳
序号加一；容量拒绝不推进序号。重放比较原完整 envelope；已消费序号永久拒绝，
不能通过改 ID、操作、payload 或重新编号使旧请求执行。

普通业务结果仍在 AppService 外层 turn 及其效果排空后封存。correlated response
新增 `consumptionReceipt`：原完整 batch 的 SHA-256，不要求客户端重新编码计算。
它是纯 native 层的 opaque final 身份，不是应用权限凭据。只有 Complete final
带可消费的收据；封存失败保留 Indeterminate，移除收据且保留已发生的不可逆效果。
2.0 的原固定容量和重放行为不变。

## 纯元数据消费

`view.live.consume` 使用独立 requestId，不占业务序号：

```json
{
  "version": "2.1",
  "inputLifetimeRevision": "7",
  "laneId": "runtime-issued-opaque-lane",
  "through": "12",
  "receipts": [
    {"sequence":"10","token":"sealed-final-receipt"},
    {"sequence":"11","token":"sealed-final-receipt"},
    {"sequence":"12","token":"sealed-final-receipt"}
  ]
}
```

运行时在任何 storage 修复、引擎 turn 或 JS 前处理该消息。元数据在类型解码和
克隆前先经 8 KiB、有界深度及节点检查。一次最多 32 项 receipt，整个新前缀
必须连续、Complete 且收据完全匹配。Pending、Indeterminate、缺项和错误收据
整批拒绝，不释放部分记录。业务容量仍为 32 项／8 MiB；消费本身不进入 final
缓存，也不触发下一层 ACK、生命周期、效果排空或资源授权。

成功 final 固定为 `{"ok":true,"consumedThrough":"12"}`。已消费 through
重复请求只检查当前实际 epoch、lane 和格式，不重做操作；也不因旧 deadline 或
取消 token 已退休而失去原成功形状。新前缀仍遵守 deadline 和取消。消费前已过期
且未生效的请求明确失败。真实输入 epoch 变化可释放旧表，但同一 lane 的最高
序号和已退休水位不重置；客户端不能用未来 epoch 触发这种变化。

## 客户端结算与清理

```js
const client = new DomLiveSessionClient({ ...options, liveVersion: '2.1' })
await client.negotiate()
await client.prepareAndPresent({ render, surfaceGeneration: '1' })
await client.consumeCompleted()
```

`consumeCompleted()` 只处理已经明确终结、资源真实排空且原始／恢复 transport
均已结算的连续已知前缀。原始请求本地超时后，即使恢复请求取得了 exact final，
仍须等待原始 promise 的实际结算。没有完整 final 时仅允许恢复原 envelope，不能
越过该序号、换 ID 或因超时删记录。onBatch 每条只调用一次；同步回调错误不会
使效果再次交付。

consume 回复丢失时，保留原不可变 metadata envelope 和全部覆盖记录，暂停新业务
事务；调用 `recoverConsumption()` 重发同一个纯 metadata 请求。仅确认成功后才
释放本地记录和字节。保留记录、业务／元数据交换 job、字节与诊断历史各有有限
预算；诊断只保存有界 code/message 快照，不保留任意 Error 引用图。
关闭等待实际未结算的 transport；无法结算的请求施加背压，不能伪造释放成功。

`Session::browser_live_transaction_retention()` 是只读协议记账：记录数、wire bytes、
最高 admission 和消费水位。它不等于进程 RSS，也不授予呈现或输入权限。

## 验证入口

```sh
cargo test -p container-runtime --features quickjs-native,v8-native --locked --test browser_live_consumption
node --test scripts/dom-live-session-client.test.mjs
node scripts/dom-live-runtime-browser-smoke.mjs --pack <text-controls-pack> --driver <dom-protocol> --out <new-dir> --live-version 2.1
```

浏览器 smoke 使用真实 portable pack、原生 QuickJS/V8 和 Chromium；验证宿主
额外附加的 passive observation 保存在原 trace，只在将 consume final 交给客户端时
剥离该验证事件。runtime 的 consume batch 本身只有 correlated response。
这些测试与官方 oracle、真实 IME、GPU 硬件和其他宿主门禁分别报告。
