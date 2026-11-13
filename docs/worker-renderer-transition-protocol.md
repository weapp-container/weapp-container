<a id="worker-renderer-transitions-protocol-slice"></a>
# 工作渲染器转换（协议片断）

**简体中文** · [English](worker-renderer-transition-protocol.en.md)


此可选协议将一个稳定的运行时所有者与连续的页面呈现器绑定分离开。它是跨家族浏览器导航的第一个源代码片段，不是一个启用的模拟器或独立浏览器功能。

`WorkerWebSession`，呈现器准入，CanvasKit/DOM 资源租用，输入适配器，调度以及命令行工具尚不协商此合同。当前产品保留其现有的固定家族重启行为。特别是，`--web-runtime browser --renderer auto` 并未由这些导出启用。

<a id="negotiation-and-identities"></a>
## 协商和身份

低级别 Worker 加载明确请求所有内容：

```js
{
  renderer: 'auto',
  rendererPolicy: { mode: 'manifest' },
  observation: { version: '1.0' },
  externalPresentation: { version: '1.0' },
  rendererTransitions: { version: '1.0' }
}
```

Worker 在应用程序代码执行前检查纯原生的 `renderer_transition_contract_json` 导出内容。在加载原始 HostSession 且在 `app.init` 之前，它调用 `enable_renderer_transitions_json`。不会创建任何替代的 Worker、HostSession、AppService 或 JS 域。该原生合约宣传了 `runtimeOwner`、`presenterBinding`、`inputLifetime` 和 `transitionFinal`，所有版本均为 `1.0`。

稳定的运行时拥有者正是 `{ workerEpoch, sessionId, packSha256 }`。
协商的观察使用版本 `2.0`；它们携带该拥有者以及一个单独的呈现器绑定：

```js
{
  version: '1.0',
  sessionId: 'session-id',
  generation: '1',
  transportBackend: 'external-frame' // or 'browser-view'
}
```

生成从 `1` 开始，仅在经过验收的跨家族过渡后递增，并使用检查过的标准 u64 字符串。它不是渲染版本、逻辑绘制表面生成、呈现许可或输入确认。旧版 v1 的观察结果和调用者保留其四字段的固定家族所有者和现有的重启要求；v1 值不能被重标记为 v2。

一个以 DOM 为优先的拥有者可以预先检查外部帧合同；一个以 Skia 为优先的拥有者在初始化前可以请求 `browserQueries: { version: '1.0' }`。浏览器查询保持可选。本阶段未协商混合拥有者的因果输入时机；将 `inputTiming` 与渲染器过渡结合会明确失败。

<a id="owner-thread-state-machine"></a>
## 所有者线程状态机

一个真正的业务转场可以导航到另一个家族的路线。v2 观察则报告 `transitionRequired: true`，同时保留旧的绑定。业务计时器、导航、存储和诊断转场继续运行；呈现、资源请求和输入操作无法使用此待定状态。不会产生渲染器策略故障、计时器取消或自动会话重启。

监督者提交 `renderer.transition`，版本为 `1.0`，并从观察到的待处理页面中提交精确的 `expected` 值：

```js
{
  version: '1.0',
  expected: {
    sessionId, pageId, routePath, rendererProfile,
    inputLifetimeRevision, presenterGeneration,
    transportBackend, surfaceGeneration
  }
}
```

工作者验证页面、硬输入生命周期、逻辑绘制表面生成和旧绑定。它在进入原生退休前保留下一个检查计数器。原生代码在原始拥有者上 draining DOM 和 Skia 输入，撤销呈现和联系权限，并退休硬输入生命周期。取消钩子可以执行应用 JS。它们永远不会被拆分、重放或回滚。

在这些钩子函数稳定之后，原生代码会重新检查实际的页面/配置文件和硬输入的生命周期。如果发生竞争条件，则返回 `ok: false`，`ERR_CANCELLED`，并保留实际效果和原始绑定。如果钩子函数抛出异常，则保留原始的原生异常；已提交的退休效果仍保留在现有会话的退休诊断流程中，不会被合成成功最终结果。

一个成功的最终增量会增加呈现器绑定，在同一个 WebHost 上选择所需的传输方式，并保留页面堆栈、应用状态、存储、定时器和原始会话身份。它会保留完整的原生效果批次。最终明确不授予任何输入。缺少或格式错误的原生最终将导致工作程序所有者出错，并保留任何返回的效果用于诊断，因为原生取消或绑定替换可能已经完成。

之后，`state` 明确报告
`presenterBindingStatus: "uncertain"`，最后一个已接受的 `acceptedPresenterBinding`，来自纯原生状态导出的 `nativeObservedState`，原始协议故障和返回的效果。该诊断并非已承认的 v2 观测。
最后一个真实的观测被保留，无需新的序列；既不将被拒绝的生成，也不将原生传输标记为已接受的绑定。接收确认和精确拥有者关闭继续进行，包括当原生状态与旧的已接受传输不同时。普通呈现、输入、资源和业务调用仍保持停止。关闭会保留诊断中的绑定故障效果，并在一次释放原始拥有者。

<a id="presentation-and-input-fences"></a>
## 演示和输入屏障

每个协商的呈现宿主请求都携带一个确切的
`presentationContext`：

```js
{ presenterBinding, pageId, inputLifetimeRevision, surfaceGeneration }
```

这适用于帧、确认、恢复、资源、缩放、退订和中止。
呈现器桥接操作还需要上下文和每次调用一个不可分割的原生信封；业务桥接批处理保留其正常的原子语义。在原生呈现/资源/输入代码运行之前，会拒绝过期的上下文。普通队列容量用于状态转换；关闭操作保留其预留的清理信用。

一个新外部绑定无法采用较旧的保留 Skia 树。原生 WebHost 要求在帧导出、回执、密度和恢复时使用当前生成帧的输入证明，当可选合约启用时。工作程序还通过呈现器生成、页面、硬输入生命周期、逻辑绘制表面和渲染修订来精确跟踪外部导出。`frame.current`、回执和恢复无法恢复先前绑定的像素或权限，包括在返回同一页面时。正常的 `frame` 请求必须创建新绑定的第一个帧。密度更新会等待其已接受的布局，自身不会评估视图表达式。现有的外部回执或 DOM 提交协议必须随后确认实际呈现；此转换最终结果并非此类证明。

关闭操作使用共享的 DOM/Skia 退役操作，并且恰好释放一次所拥有的 HostSession。原生 UI/GPU 资源仍属于其呈现器租约；该协议不会创建或销毁浏览器呈现器。

<a id="remaining-product-work-and-evidence-boundary"></a>
## 剩余的产品工作和证据边界

下一个切片必须原子性地协调 `WorkerWebSession`、呈现器和调度器替换、资源租约、延迟查询/ACK结果、实际的DOM和CanvasKit呈现、输入取消、上下文恢复和关闭。只有在此之后，产品才能协商此配置，CLI浏览器自动防护机制方可考虑。静态导出站点和每个原生宿主仍为独立工作。

配套的 Rust 定义涉及原生身份、存储/定时器保留、过期预检、启用/卸载和帧证明拒绝。注入的 Worker 测试定义了双向绑定变更、定时器/就绪/重绘导航、过期输入/ACK/资源栅栏、取消竞争、格式错误的最终状态、精确的 v2 观测和清理。编写这些定义本身不是执行证据。它们并不能证明实际的 WASM/QuickJS 执行、浏览器呈现、GPU、性能、七宿主兼容性或官方微信一致性。本协议片段对冻结的 279 验收门禁没有影响。


<a id="trusted-native-interleaving-definitions"></a>
## 可信原生交错定义

额外的仅 QuickJS 运行时原生定义使用一个原始的 WebHost 及其公共 `app.init`、生命周期、视图准备/几何/提交/呈现和触摸事件 API。几何 peer 是合成的；JS 事件监听器及其存储、数据、定时器和导航效果在根运行这些测试时，由实际编译的 QuickJS 提供程序执行。

一个可信的原生嵌入器故意在请求宿主更改其传输绑定之前附加目标 DOM。该公共 API 的交错调用会触发退休回调，这些回调在单个回合内导航离开、再导航返回，或在提交写入后抛出异常。这并不代表当前工作程序协议所允许的路径：正常的 Worker 导航在暴露待定的渲染器家族转换之前，已经取消了旧页面的连接。没有修改会话字段以伪造回调、页面、输入生命周期或结果。

这些定义要求回调效果能够持续存在，取消/错误时旧的绑定保持不变，旧的许可和触碰保持被撤销，业务定时器保持在原始所有者上，重复的本地退休/卸载操作需避免重新播放联系。这些定义不涉及浏览器、GPU、设备、原生平台的清理操作，也不提供官方微信一致性证据。
