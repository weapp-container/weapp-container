<a id="live-document-v2-explicit-experiment-protocol"></a>
# Live Document v2：显式实验协议

**简体中文** · [English](browser-live-document-v2.en.md)


这条路径为后续原生编辑 lease 提供稳定 Document、接收者身份和呈现事务。
它明确协商 `nativeEditing:false`，准备到最终 ACK 期间通过原生 `inert` 冻结输入，
不承诺焦点、撤销栈或中文 IME 跨更新连续。普通模拟器和 Worker 仍使用 v1。

<a id="data-and-transactions"></a>
## 数据与事务

仅新的 browser presentation owner 可以先发送 `view.live.enable`，payload 为
`{"version":"2.0"}`。返回 contract 声明 document permit、live geometry finalization、
完整最终结果重放、有限保留预算及硬输入 revision。已有 v1 owner 不能迁移协议。
外层 `BridgeEnvelope.protocolVersion` 继续为 `1.0`；`2.0` 是这份独立呈现合同的版本。

1. `view.live.prepare`：发送版本、runtime 发放的 `inputLifetimeRevision`、
   decimal-string `surfaceGeneration` 和原 render 请求。结果包含完整已求值文档、
   viewport、完整 `PresentationKey`、必填且可为 null 的 `baseKey`、document token
   及每个 occurrence 的 runtime identity。求值使用实际 AppService 与 View 引擎。
2. `view.live.permit`：发送上述精确身份，**没有 geometry**。runtime 为保存的候选
   发放 5 秒 document permit；重复请求不能延长 deadline。
3. 浏览器准备 typed patch，获得 permit 后才应用到同一个 live Document；保留
   rollback journal 和前驱资源。等待真实图片 decode、fonts.ready、RAF，再测完整几何。
4. `view.live.presented`：发送完整 permit 与 geometry v1 形状。runtime 在任何发布前
   校验完整 occurrence、key、viewport、epoch 和几何；随后原子接纳文档及几何，
   执行 ready 等效果并返回完整 outer-turn final。
5. `view.live.abort`：精确 key、document token 与硬 revision，只能撤销尚未接受的候选。
   旧画面可保留，旧输入授权不会因此复活。v1 prepare/permit/ACK/abort 不能操作 v2 owner。

不可逆发布后即使 ready 超时或 final 保留失败，结果仍携带 `committed:true` 和 key。
客户端必须先接纳这份发布事实，保持输入关闭并报告错误，不能回滚已接受的 DOM。

<a id="recipient-and-resource-ownership"></a>
## 接收者与资源所有权

QuickJS/V8 在应用代码执行前保留私有 capture function，用私有 WeakMap 识别真实
Page/组件对象，不调用用户 getter、toJSON 或应用覆写的原型方法。对象卸载或销毁先
退休，再执行用户 hooks。runtime 将这些 token 与 occurrence、组件/slot 归属、tag、
key、type/password 合成单调 binding incarnation。普通数据或 value 变化不换身份；
移除、重建或 A→B→A 不能恢复更早的身份。获取身份失败会撤销候选。

`DomLiveSurface` 持有自己创建的 root/style，借用 Document、iframe 和 mount。
普通 patch 可复用相同身份的实际节点；plan 预检不修改 live tree。decoder、RAF 和
前驱资源按真实最后使用点释放。dispose 不移除借用节点或无关同级节点。
接纳文档同时保留该文档的私有 receiver snapshot，touch contact 共享原 snapshot。
v2 的 `view.events` 及 contact cancellation 使用 native 保留的 dispatcher，先完整预检
receiver，再在每个 handler lookup 前、getter 后和实际调用前核对 Page/组件 incarnation。
scope 解析使用私有 own descriptor，应用覆写 `hasOwnProperty` 不改变事件归属。
返回值序列化及本 task 的 microtask checkpoint 后再检查实例；发现退休便撤销旧画面
的硬输入权限，返回 `ERR_CANCELLED`，保留先前回调和 setData 已发生的效果。
普通 setData 不更换真实 receiver，listener 间仍不插入 microtask checkpoint。

这条校验仅接入显式 v2 owner，公开 v1 派发保持原边界。它不发放原生编辑 lease，
也没有延后编辑队列、可信 source-edit acknowledgement 或更新中的焦点/IME 连续性。

<a id="exact-final-and-capacity"></a>
## 精确 final 与容量

prepare/permit/presented/abort 必须各占一个独立 owner turn；含任一 live operation
的混合 bridge batch 在进入 JS 前全部拒绝。reserve 在 storage sync 与 JS 前进行，
只有 outer turn 完成及失败效果处理后才 seal。相同 requestId、完整 envelope 内容相同
才允许同 epoch 重放；修改 payload、deadline、trace 等也会拒绝。pending 或无法保存
的 final 留下 tombstone，不能重新执行。客户端丢失 ACK 时只重发原 envelope。

当前每个硬输入 epoch 最多保留 32 个事务请求、8 MiB 请求与 final 字节；单请求
256 KiB，预留 final 512 KiB。不软淘汰旧结果，容量用尽明确要求更换 owner。
它还不是无限 watch 循环的生产保留策略。硬输入生命周期退休后，旧请求返回
`ERR_CANCELLED`，不能跨 epoch 恢复执行；AppService 故障需要更换整个 session。

<a id="runtime-verification-entry-point"></a>
## 运行验证入口

```bash
cargo build --locked -p container-host-common --example dom-protocol \
  --features container-runtime/quickjs-native,container-runtime/v8-native
pnpm host:webview:live-smoke --pack /absolute/path/to/text-controls-pack \
  --driver /absolute/path/to/target/debug/examples/dom-protocol --out /new/evidence/directory
```

该入口使用一个后台 Chromium、一个页面，顺序验证真实 QuickJS/V8 portable pack。
它不会替换模拟器服务。默认 readiness 来自真实浏览器；传输丢失和 readiness 失败
属于明确注入的故障，不是官方工具或硬件证据。fixture 必须保留实际 focus callback
的 setData，不能靠删除回调消除反馈。没有图片的 fixture 不能证明图片资源链路通过。

后续仍需完成 editing lease、按实际 receiver token 校验的延后事件派发、有界消费水位、
Worker/remote 产品接线、中文 IME 与焦点连续性，以及七宿主和性能门禁。
