# 浏览器开发态控制 final ACK

控制操作、HTTP 传输和客户端采纳是三个不同阶段。原 `ControlLedger` 先预留容量，
只执行一次操作并保留原 final 字节；断线后只能查询同一个请求的结果。
HTTP 写出、SSE 通知、超时或新 snapshot 都不能授权压缩这份结果。

## 原账本入口

`ControlLedger::acknowledge_final(authenticated_run_id, original_request_bytes,
exact_raw_final_sha256)` 在原账本内重新绑定请求，不要求调用者重建包含私有 serial
的 `ControlIdentity`，也不新增身份表。原请求仍按既有 canonical 合同匹配；final 哈希
必须针对收到的原始响应字节，不能对解析后的 JSON 重新编码再取哈希。

| 原状态 | ACK 行为 |
| --- | --- |
| `Final`，哈希正确且无在途 response/replay borrower | 压缩为 `FinalCompacted`，返回 `compacted`。 |
| `Final`，仍有原 Arc borrower | 返回 `Capacity`，保留原字节与费用，允许同一 ACK 稍后重试。 |
| 同一 compacted 请求及同一哈希 | 返回 `already-compacted`，支持 ACK 回复丢失后的重试。 |
| 错误 run/client、冲突请求、错误或非规范哈希 | 明确拒绝，不改变序号高水位或容量。 |
| queued、executing、prepared 或非最终 tombstone | 拒绝，不能以 ACK 解除执行或清理的不确定状态。 |
| retired/unseen，包括高水位以下的未见空号 | 返回 `RetiredOrUnseen`；不能证明旧哈希被接受，也不会重新入队。 |

此入口复用原 `compact_final` 的 borrower 与费用屏障，不克隆一个会阻止自身压缩的
final Arc。它不自动退休 tombstone：原 tombstone 继续保留请求指纹与 final 哈希，
entry 数量仍有界。高水位只能防止旧 ID 再执行，不能在删除指纹后证明旧 ACK 的内容。

认证 run/client 必须来自 owner 的已选定 manager 上下文，不能仅信任 HTTP 请求自报。
ACK 只证明该客户端确认保留 final，不证明 Worker 已关闭、当前画面已呈现或站点仍
对应最新源码。这些仍分别需要 exact close、presented receipt 和 fresh source barrier。

## Manager 的可选采纳接口

`BrowserDevOwnerManager` 保留既有 `control.invoke/replay`，可选接受
`control.acknowledge(request, originalParsedFinal)`。manager 先完整校验并应用 final，
将其保留在原 command 记录中，再调用 ACK。传给 transport 的是它返回的那个原始
parsed 对象，可通过 WeakMap 关联收到的字节哈希；不是 manager 复制后的对象。
transport 仍须验证原始 body、请求、认证身份与服务端 ACK 回执，不能仅因对象相同
就推断 ACK 成功。

每个 command 最多保留一个实际在途 ACK，全局由
`maxFinalAcknowledgementsInFlight` 限制，默认 8、最大 64。ACK 出错不会重新 invoke、
消耗清理 command serial、撤销已采纳结果或把 owner 标为不确定；失败留在原 command，
由调用者显式重试，没有后台 timer 或第二份命令队列。相等的迟到 final 不再提交第二个
ACK；冲突仍是 sticky 控制协议错误，不确认冲突结果。

`retryFinalAcknowledgements({maxOperations})` 有界推进原 command 表中的重试工作，
立即返回计数，不等待网络。`status`、`recover()` 与 `close()` 分别报告
`finalAcknowledgements` 和 `transportDrained`。必要的 Worker/owner 关闭继续按原屏障
完成；`closed:true`、`workerClosed:true` 或 `coordinatorStopped:true` 不等于 ACK 网络
已清空。`transportDrained:false` 时，调用方须继续保留或显式关闭所属 control transport，
不能丢弃尚未 settle 的请求。

## 接线与验证边界

本入口不开放 HTTP 控制路由或 browser watch CLI。静态资源专用入口仍只接受 allowlist
内的 GET，不能用它发送 ACK 或 activation。manager 的可选 seam 不包含 HTTP transport；
原始响应关联、服务端鉴权、收据发送及实际网络退出清理仍须单独接线和验证。

独立的 [HTTP 客户端](browser-control-http.md) 已提供原始字节关联、有限请求与关闭
barrier，供后续 owner 接线；现有静态服务不会因该模块存在而开放控制端点。

这里的状态规则属于控制收据合同；Rust 或受控 JS transport 测试不能替代实际 Worker、
浏览器、呈现、GPU、七宿主或性能门禁。
