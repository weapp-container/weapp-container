# AppService 执行时限

宿主可通过 `SessionConfig.engine_execution` 为 QuickJS 启动和每次宿主操作设置时限：

```json
{
  "engine": "quickjs",
  "engine_execution": {
    "bootstrap_timeout_ms": 5000,
    "turn_timeout_ms": 250
  }
}
```

两个字段均为可选整数，接受 1–86400000 毫秒。默认均为 `null`，保留已有宿主的无时限策略。这组数值是配置示例，不是帧率或性能验收指标。需要有限执行策略的 Worker 宿主必须显式设置两个字段。V8 和未编译 QuickJS provider 的构建会拒绝有限策略，返回 `ERR_ENGINE`。

一次宿主操作使用同一个单调时钟截止时间。模块注册和求值、回调、结果序列化、异常读取、microtask、存储及能力同步都在其中。`dispatch_batch` 的多个请求共享外层时限；嵌套调用和请求 deadline 只能缩短它。定时器、resize、网络通知、呈现确认、浏览器事件、触摸取消和开发态替换直接调用 `Session` 时也经过该边界。开发态候选与当前 Session 共享操作的绝对截止时间；View 求值及作用域释放只获得剩余预算。

普通同步异常仍在同一操作内执行 microtask checkpoint，并保留原异常和已经产生的 effects；不会把 Promise 清理推迟到下一次请求。checkpoint 超时或取消时优先返回执行故障，停止后续 JS 清理。QuickJS 与 V8 共用普通异常的 checkpoint 分发路径；这不表示 V8 已支持有限执行策略。

QuickJS interrupt handler 检测截止时间和引擎级取消标记。首次中断保留 `ERR_TIMEOUT` 或 `ERR_CANCELLED`；已经故障的 realm 只能由新 Session 替换，后续可执行请求返回 `ERR_ENGINE`。错误响应包含 `requiresRestart: true`，`Session::execution_fault()` 返回首次故障。不能把用户自行抛出的同名错误字符串当成引擎中断。

引擎级 `EngineExecutionBudget.cancellation` 接受宿主持有的 `Arc<AtomicBool>`。当前 Session 的 `cancelToken` 只检查请求准入和 Provider 取消，没有公开可在执行中从另一线程取消 AppService 的句柄；不能把这两层能力混同。

中断后不执行应用错误处理、回滚、effects drain 或 unload hook。运行时撤销输入、几何及待呈现授权；旧画面只用于诊断。已经被 Rust 消费的事件保留在响应批次中，未消费的 JS 队列不再执行。`cancel`、`diagnostic`、`error` 控制消息仍可使用；`diagnostic` 回应包含故障和重启要求。宿主应使用 `HostSession::unload` 或释放 Session 回收故障实例，而非发送会执行应用代码的 lifecycle unload。

`app_service_mut()` 保持原有 Rust API：借出前的 contact retirement 受时限约束，故障保留在 Session 和诊断流中；获得原生状态引用不会恢复 JS 执行权限。渲染倍率和已接受画面的 GPU 提交不执行 JS，不建立新的应用操作。

这不是硬实时沙箱：同步 Rust Provider、分配器、GC 和编译器原生工作不保证能被 interrupt callback 立即抢占。排队的 Worker `postMessage(cancel)` 也无法打断正在运行的同步 WASM；Worker 宿主还需有独立 watchdog，并在正常关闭超时后终止自己创建的 Worker。强制终止不保证应用 unload、存储 flush 或会话保留。

回归入口为 `container-engine-quickjs/tests/appservice_deadline.rs`、`container-runtime/tests/appservice_turn_budget.rs` 和 `container-runtime/tests/appservice_exception_checkpoint.rs`。无限执行用例使用各自子进程 watchdog；这些本地契约测试不替代实际 WASM Worker、GPU、官方 DevTools、设备或性能证据。
