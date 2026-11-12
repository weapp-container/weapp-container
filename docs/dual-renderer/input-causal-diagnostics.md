<a id="web-input-causal-diagnostics-v1"></a>
# Web 输入因果诊断 v1

**简体中文** · [English](input-causal-diagnostics.en.md)


该接口记录输入、原始 View clone、GPU 提交、canvas 替换和 runtime ACK 的独立事实，
用于准备真实的 375×667、2× 测量。当前没有 compositor frame-flow、合成器呈现反馈
或物理屏幕证据；所有报告始终为 `gate.status: "blocked"`，
`inputToPresentP95Ms` 和滚动丢帧率保持 `null`。协议阶段耗时不能当作输入到屏幕耗时。

<a id="explicit-enablement"></a>
## 显式启用

Worker Skia owner 和开发 manager 接受可选的 `inputTiming: { version: "1.0" }`。
默认调用不发送 sideband，Worker 的旧 load、frame 和 bridge 回执不增加该字段。
DOM Worker 显式启用时返回协议错误，不能静默换测量口径。

开发 manager 在构造替代 owner、绘制资源准备和退休旧 owner 前，检查固定 runtime
导出的完整 `INPUT_TIMING_CONTRACT`；缺失或未知声明保持旧 owner 可用。
实际 load 还必须返回相同协商结果。静态声明和 load 成功都不证明 GPU 或呈现成功。
旧 owner 已真实关闭后的 load 失败仍遵守现有单实例边界，不能回滚已销毁的 JS heap。

`WorkerWebSession.inputTiming` 返回当前 owner 的不可变报告；开发 app 的
`inputTimingReport({ ownerKey })` 要求精确 owner key，并返回 identity、stale 和报告。
它不暴露 session 对象，不授予输入权限。错误 key 明确拒绝。

原生输入 helper 只在传输的外层 host context 携带 `{ version, sampleIds }`；
业务 bridge envelope、事件、顺序和批量边界不变。一次原生 pointerup 产生的
touchend/tap 共享一个 sample，不能重复计算成两次物理输入。

<a id="association-and-clocking"></a>
## 关联与时钟

每个样本绑定不可变 Worker owner/session、捕获时 page、模板 revision、surface generation、
input lifetime 和逻辑 viewport。Worker 在真实 native dispatch 前后只读状态，并记录
真实 outer/inner request ID 与最终结果；不以 HTTP 收据或开始执行当作 applied。

只有成功输入确实改变模板 revision、没有跨 page/viewport/generation/lifetime，
且原始 render 的 consumed-input proof 消费了同一个改变后的 revision，才记录
`exact-data-revision` 候选。仅“输入发生在 clone 前”记为 `ordered-only`。
后续 timer revision、no-op、缺失状态、页面切换或旧帧均不能升级为强关联。
该候选仍只说明数据 revision 关系，不证明目标像素发生可见变化。

Worker 在原始 render 时冻结 clone receipt；`frame.current`、倍率重绘和恢复只能
复用相同 consumed-input 的原 receipt。它们不能把最新 applied 序号贴到旧 clone。
原始 clone 无 receipt 时明确 incomplete。

Window 使用自己的单调时钟记录输入捕获和各阶段回执接收时间；Worker 时间保持独立
的 `worker-monotonic` 域，DOM `event.timeStamp` 保持 `dom-event-unmapped`。
两域不相减，不通过墙钟校准。时钟缺失、负值或倒退记录 fault，候选耗时不再输出。
报告只提供同一 Window 域内的 `protocol-stages-only`，不生成分位数或通过结论。

四个后续事实分别是 original clone received、validated GPU submitted、不可逆 visible
canvas swap、真实 runtime ACK received。canvas swap 的名字指 DOM 操作完成，
不是 compositor display。迟到、失败、丢弃、重复、未知 receipt、owner 退休都保留为事实。

<a id="boundedness-and-diagnostics-isolation"></a>
## 有界性与诊断隔离

每个 owner 最多保存 512 个输入、64 个 frame、2048 个事件（上限 4096）。
每个 sample 最多链接 4 次 frame 尝试，每帧最多链接 128 个 sample；Worker 最多
保存 32 批 applied 事实，每批最多 64 个 ID。淘汰和省略显式计数，不用单个
`lastInputAt` 覆盖并发输入。物理目标沿用边长 4096、RGBA 16 MiB 上限。
只保存身份、revision、尺寸、时间与结果，禁止保留事件业务 payload、数据或资源内容。

诊断回调不能更改输入、dispatch、JS、调度、呈现和关闭 barrier。同步异常单独计数；
异步回调不被等待，拒绝被观察，不能吞掉真实业务错误。计数只描述诊断完整性。
诊断成本尚未实测，不能据 Node 测试声称没有性能开销。

启用后的外层 `inputTiming` 是可省略的诊断字段。客户端和 Worker 先独立校验并
预留原业务 payload，诊断不消耗业务 in-flight byte credit；取消后的实际 final
所有权仍只按原业务字节保留。每条诊断另限 256 KiB、8192 个节点、16 层，
并受原有有限请求数约束，不扩大业务消息或队列门槛。发送时仍必须满足原来的
整条消息字节、节点与深度上限；不足时只省略诊断，不能重试业务或改写业务结果。

输出诊断与 native 业务 DTO 分开保管，业务 final 校验成功后才尝试附加诊断。
有空间时返回 `{version:"1.0", omitted:"payload-budget"}` 等固定提示；提示本身
也放不下时不发送该字段。Window 的有界 ledger 将缺失记为 `not-delivered`，
不推断远端具体原因。`omittedDiagnostics` 和 `diagnostic-omitted` 事件明确记录
诊断不完整；该帧不产生因果候选。原始 clone 的 receipt 不因传输省略而被覆盖，
后续有空间的 retained export 仍只能使用原始 receipt。

<a id="remote-and-legacy-ui"></a>
## Remote 和旧 UI

Remote raster/DOM 没有 native input→original-clone token，因此只保存独立输入批次
及其精确协议完成记录；报告为 `association: "unavailable"`，不关联下一帧。
开发 UI 可调用 `globalThis.__weappInputTimingReport()` 读取有限历史。

旧 UI 的 `presentedAt`/`inputToPresentMs` 已移除。DOM 使用
`transactionCompletedAt`/`dom-protocol-completed`；GPU 路径显示
`gpu-submit-and-runtime-ack`；CPU 软件路径使用 `drawCompletedAt`/
`canvas-putImageData-return`。显示的 transaction 时间不能升级为屏幕呈现时间。
保留的 `presentMs` 是兼容字段，含义是当前 transaction 的主线程耗时。

`simulator-presentation-smoke.mjs` 的软件测试读取 `drawCompletedAt`，其旧报告保留原字节。
该脚本的历史 CPU/RAF 指标不能证明 Worker CanvasKit、GPU、合成器或物理显示通过。
新的完整性能门禁必须另行获得因果像素、frame-flow 和呈现端点，并保存独立原始证据。

<a id="verification-boundaries"></a>
## 验证边界

Node 合同覆盖默认兼容、静态/实际协商、真实 Worker RPC 代码中的 request correlation、
原始/retained clone、timer/no-op/跨代隔离、界限、时钟、诊断抛错、Remote 多输入和阶段分离。
其中 native host、DOM、GPU 与时钟可使用受控 double；这不是 Cargo、WASM、真实浏览器、
硬件或性能测量。后续实际执行必须单独绑定源码、编译器、pack、环境和原始报告。
