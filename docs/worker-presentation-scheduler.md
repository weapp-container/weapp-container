<a id="worker-presentation-scheduler"></a>
# 工作程序呈现调度器

**简体中文** · [English](worker-presentation-scheduler.en.md)


此纯模块没有产品入口点导入，也不实现 Worker、RPC、DOM 呈现器、CanvasKit 绘制表面或运行时通信。确定性 Node 测试覆盖了其注入的适配器合约。产品集成以及实际的浏览器、GPU、性能和近似性门控仍为独立要求。

<a id="scope-and-explicit-integration-blockers"></a>
## 范围和明确的集成阻塞因素

`PresentationScheduler` 每次只接受一个分阶段的呈现。它将普通脏观测合并为一个最新需求，并最多拥有一个帧率调整帧（RAF）。它从不评估 JS、获取帧、调用 HTTP 端点或自行选择另一个引擎/渲染器。适配器提供实际的事务。

以下先决条件在产品使用它之前仍然需要：

- Worker `frame`/`frame.current` 必须协商并返回精确版本克隆时消耗的输入。空值/手动/脱离的帧是不足的。新的可选外部呈现线程现在提供了该精确版本的元数据；其存在仍不会安装实际的呈现适配器。
- 外部确认需要真正的最终 `{ acknowledged, renderRevision,
  inputEnabled, requiresRestart, batch }` 合约。桥接批次、事件确认、排队接收、本地提交或最新运行时状态均不能替代它。
- `DomSessionClient` 现在暴露了严格的 `prepareTemplate`、`presentPrepared` 和 `releasePrepared` 阶段。产品适配器必须直接使用这些阶段，绝不能调用兼容的 `present()` 方法并在之后生成证明。调度器必须在 DOM 发布/确认前冻结证明。
- 选择性启用的有序 Worker 观察通道现在提供了逻辑上的 `surfaceGeneration`，与原生输入生命周期绑定。产品所有者必须为 DOM 请求和输入坐标生命周期保留该精确值。
- 选择性启用的有序通道提供了标准序列；产品集成必须保留它们。一个过时的 RPC 响应不能仅仅因为其到达时间较晚就接收新的序列。
- 渲染策略协商、重启所需行为、资源授权、密度事务以及实际 Worker 的关闭仍属于所有者的职责。纯合约测试不能确立实际的产品所有权或呈现。

<a id="public-api"></a>
## 公共 API

```js
const scheduler = new PresentationScheduler({
  owner: { workerEpoch, sessionId, packSha256, transportBackend },
  adapter, requestFrame, cancelFrame, onError, onState,
})
scheduler.observe({ sequence: '1', state })
scheduler.retry() // explicit retry only after a blocked attempt
const status = scheduler.status
const closing = scheduler.close() // every call returns this same promise
```

所有权身份是不可变的。`transportBackend` 为 `browser-view` 或 `external-frame`；`packSha256` 为小写 SHA-256。会话/包替换需要在旧所有者关闭后创建新的调度器。调度器没有主线程 WASM 或软件/HTTP 降级。

一个需求状态包含这个确切的调度子集：

```js
{
  owner,
  currentPage: { pageId: '1', path: 'pages/index/index' }, // or null
  templateRevision: '5', renderRevision: '8', viewRevision: '12',
  surfaceGeneration: '1',
  viewport: { x: 0, y: 0, width: 375, height: 667 },
  rendererProfile: 'skia', // skyline-compat or webview
  lifecycle: 'Active',    // Created, Background or Destroyed
}
```

所有 u64 ID/修订版/序列号均使用标准十进制字符串和 BigInt 进行比较。`viewRevision` 如果存在将被验证然后丢弃。这是活动账务记录，绝不是重新运行 WXML/WXS/现代视图的指令。较旧或相等的观察序列将被忽略。在逻辑生命周期内回退修订版将导致调度器出错并冻结输入。无效的所有者/形状将被拒绝。

页面 ID/路径、逻辑视口、有效呈现器、生命周期和逻辑绘制表面生成构成一个硬性输入边界。其变更会同步冻结输入，取消所拥有的 RAF，并通知飞行任务中止。在继任者启动前必须释放旧的候选者。非活动/无页面状态不会渲染。传输族不匹配将永久要求新的拥有者；不会发生静默的呈现器切换或会话重启。

注入的函数可以同步重新进入 `observe`、`retry` 或 `close`。
新的权威观察和完整的退出/最终/故障转换在通知代码运行之前被安装。退出会捕获旧的 RAF 和飞行，而不是捕获任何嵌套回调可能后来创建的资源。嵌套观察可以推进最新的需求，但在捕获的旧 RAF 取消/飞行中止屏障返回之前，不能承认后继者。外部观察在嵌套观察之后无法恢复其先前的需求。

纯密度和CSS显示缩放必须不会改变该逻辑生成。
密度在拥有者通道上进行协调，在需要时生成真实的保留帧绘制修订版本，并使用 `preparePaint`，保留已消耗的模板输入。
显示缩放属于浏览器呈现，无需响应任何新的需求。
如果未来的物理绘制表面API需要单独的纪元，必须保持这一区别；不要通过在此处无效化模板输入来模拟密度。

<a id="adapter-phases-and-proof"></a>
## 适配器阶段和证明

每个适配器方法都是必需的，即使后端拒绝了不支持的阶段也是如此。调度器调用：

1. `prepareTemplate(demand, context)` 用于首次/变更的模板或逻辑输入；
   `preparePaint(demand, accepted, context)` 用于更新的保留外部绘制。
2. 验证/复制/冻结 `candidate.proof`，然后等待一个所属的 RAF。
3. `present(candidate, { ...context, proof, timestamp })` 用于精确的事务。
4. `release(candidate, { owner, attemptId, proof, committed, retired })` 恰好为每个返回的候选者执行一次，包括格式错误或延迟的结果。

Worker CanvasKit 所有者选择 `preparationScheduling: 'microtask'`：最新观察值在一次轮询内合并，异步帧准备在 RAF 之前开始，只有可见的安装会等待 RAF。通用默认值仍为 `'frame'`。一个待处理的准备令牌使用与准入 RAF 相同的退役槽位（`status.hasRaf` 也涵盖此排队准入），但没有浏览器句柄可以取消。关闭、调整大小和导航会作废该精确令牌，并且仍会耗尽已启动的飞行，直到其后继者。

CanvasKit 准备仅提交脱离的后缓冲区并验证其本地回执。它无法交换可见画布、确认修订或启用输入。
`present` 将已提交的缓冲区安装到 RAF，然后等待精确的运行时回执。失败或已退役的准备会释放其脱离的资源；显示的前缓冲区保持不变。

上下文具有不可变的拥有者/尝试/绘制表面身份，AbortSignal 和 `isCurrent()`。适配器必须在每次不可逆的发布、ACK、启用输入或解码资源安装之前检查当前所有权。观察结果以及 `onState`/`onError` 回调必须及时消费，且不得等待来自 Worker 事件信用回调的渲染。

`freezeInput`、`onState` 和 `onError` 是同步通知；返回的 Promise 不会等待，且不得携带必需的清理操作。异步清理属于分阶段适配器方法。每个通知都可能关闭或推进调度器；调用方必须读取当前状态，而不是将先前发出的状态解释为持续的授权。

归一化的注入证明不是一个新的运行时协议：

```js
{
  version: '1.0', attemptId: context.attemptId,
  owner: context.owner, surfaceGeneration: context.surfaceGeneration,
  consumedInput: {
    pageId: '1', routePath: 'pages/index/index', templateRevision: '5',
    viewport: { x: 0, y: 0, width: 375, height: 667 },
  },
  publication: { kind: 'external-frame', renderRevision: '8' },
  // DOM alternative: { kind: 'browser-view', key: {
  //   sessionId, pageId, documentRevision, presentationRevision,
  //   surfaceGeneration, profile: 'webview'
  // } }
}
```

适配器仅从真实的精确版本/键绑定的准备/帧元数据创建此包装器。它可能添加本地尝试/所有者身份，但不会从预请求需求、最新 `state`、后钩子数据或 ACK 中填充已消耗字段。外部元数据的直接 f32 几何必须与帧匹配；DOM 的现有 f64 视口是另一种编码。该模块复制经过验证的数值，并不会自行进行转换。缺少权威的已消耗输入将明确失败；它不会通过猜测基线来修复。

生成的模板必须消耗捕获的页面/路由/逻辑视口，并且模板版本必须大于或等于捕获的下界。实际的clone5在满足捕获需求4时是有效的。Paint必须精确携带已接受的旧消耗输入，即使当前页面数据更新。外部修订必须是精确的正字符串，且不得早于需求或重放已接受的发布。DOM会将完整的呈现键与捕获的会话/页面/表面进行验证。它不会从调度器接收任何外部数值确认。

`present()` 返回一个最终值，其内容与原始发布完全相同，`acknowledged:true`，布尔值 `inputEnabled`，以及可选的布尔值 `requiresRestart`。在真正的最终事务完成后返回，并通过所有者通道保留诊断信息和效果。对这个最终值上的任何 `consumedInput` 或 `scheduling` 装饰都忽略。已提交的输入禁用结果保留其实际的视觉基线。如果在相同不可变所有者和完整硬输入键下存在一个更严格的新版本有序需求，且该需求需要的模板输入版本比克隆时消耗的输入版本更新，或者外部渲染修订版本比其精确发布版本更新，则该提交将被覆盖。输入保持冻结，不会产生任何错误，下一次飞行只在该候选释放屏障之后运行。后继者必须获取自己的真实启用 ACK。任何需要重启的最终值始终是终端状态；ACK 装饰、更新的观察序列本身、viewRevision/activity，以及已被实际克隆消耗的修订均不能证明其被覆盖。没有这样的后继者，输入禁用的提交将被视为明确的失败并被阻塞；未更改的活动无法触发新的 ACK/评估。一个延迟的不可逆最终值可以在硬屏障之后标记为 `committed` 以进行清理，但永远不能成为新的接受状态或输入权威。

`release()` 释放尝试所有者拥有的待处理/临时租约；已接受/已显示的租约已转移到呈现器的已接受记录中。已提交的候选者不得被远程中止或释放正在显示的资源。`committed:false` 表示调度器未验证真正的最终状态；这并不能证明本地交换或运行时回执从未发生。如果适配器在抛出或返回格式错误的最终状态时存在，必须保留其自身的不可逆状态记录，且不得从该标志推断出安全回滚。在取消后，释放操作是安全的且可重复执行。在中止之后准备的候选者仍保留旧所有者的清理工作。一次飞行包含释放操作，因此不会出现第二次运行时执行与后期清理重叠的情况。资源授权、预算、URL/图片租约以及最终渲染器的销毁仍由适配器负责。

<a id="coalescing-failure-and-scheduling"></a>
## 合并、故障和调度

每个飞行捕获一个需求。普通的新需求会替换一个待处理值，而不会中止飞行或推进呈现权。一个空操作活动事件不会安排任何任务。在成功情况下，被接受的基线来自预呈现证明。只有当最新的模板输入或保留的绘制修订版本比该实际基线新时，下一个飞行才会运行。

captured4，cancellation updates data before root clone5，component hook
writes6，ACK ready writes7。第一个被接受的基线是5。被排队的7会导致一个后继者；它永远不会被错误地标记为已消费。如果最新的通知仅仅是5，那么就没有冗余的后继者。

失败有一个独立的水印，从不被视为可接受的基准。在证明之前，它使用捕获的需求；在有效准备之后，它使用实际消耗的证明。因此捕获4 → 克隆5 → 展示失败 → 最新5仍被阻塞。未变更的活动/定时器不会反复评估相同的失败输入。真正的更新需求或显式`retry()`允许一次新的尝试。失败的绘制重试仍属于绘制工作，无法生成新的模板。发布错误会保留任何实际提交的视觉基准，冻结输入，并使该调度器出错。清理未被证明完成，因此不能自动发起需求或显式重试来启动另一次执行；必须由所有者关闭并报告。RAF取消失败也会在错误通知或继任者接纳之前故障所有权。其错误仍属于最终关闭聚合的一部分。

调度器的 RAF 注入可以实现呈现的 FPS 节奏；它不驱动 JS 定时器或显式桥接切换。通用帧准入模式可以增加刷新间隔；Worker CanvasKit 使用微任务准入来避免该延迟。此处并未声称输入到呈现之间的绑定关系；产品集成后，应测量真实的 Worker/WASM/呈现器开发循环。

`requestFrame(callback)` 同步返回精确的可取消句柄。
其调用可能会同步触发集成代码，包括硬观察或关闭。注册会阻止后续准入，直到返回的句柄已知；如果在返回前被废弃，调度器将一次性取消该精确的最终句柄，永不为 `null` 或后续句柄。`cancelFrame` 也可能重新进入。一个抛出异常的 requestFrame 实现不得在不返回其句柄的情况下遗漏已注册的工作。同步调用的回调被视为已完成，无需后续取消。这些合约与实际浏览器 RAF 时序无关，不构成浏览器性能结果。

<a id="stable-close-and-finite-cancellation-contract"></a>
## 稳定关闭和有限取消合约

`freezeInput(reason)` 是同步操作。异常会中断调度器；后续工作将无法启用输入。`close()` 在调用任何注入的回调之前发布其稳定承诺，立即标记关闭/加栅栏，取消 RAF，中止飞行并冻结输入。然后按顺序调用：

1. `cancelOwnedWork(reason)` 使已拥有的待处理操作完成结算，同时保持传输和精确键清理可到达。它不得等待其等待的调度器飞行，也不得销毁 `release()` 所需的传输。
2. 等待包含延迟候选释放的飞行。
3. `dispose()` 用于释放适配器所拥有的最终呈现器/传输/Worker 资源。

所有清理阶段都在先前失败之后运行。错误会聚合到关闭承诺中；通知回调错误无法获得权威或跳过清理。一个待处理的准备/释放必须响应信号/取消OwnedWork，并在有限时间内完成。调度器无法强制终止任意的非合作性 Promise。产品负责人仍需对其实际的 RPC 关闭/监控/拥有的 Worker 终止负责。本模块不会生成重复的应用卸载。

<a id="deterministic-contract-tests-and-evidence-limits"></a>
## 确定性合同测试和证据限制

`scripts/presentation-scheduler.test.mjs` 包含确定性延迟承诺和伪 RAF 情况，用于无操作活动、模板/绘制分离、实际克隆水印、后置钩子/ACK 更新、合并、相同失败抑制、强制重设、隐藏/显示、格式错误的证明、突变隔离、被阻塞的已提交结果、过时观察、家族不匹配、DOM 键、稳定/递归关闭、延迟 ACK、清理聚合/故障、精确的 u64 值以及保留证明/回执拒绝。递归修正增加了 12 个回归测试，涉及初始/排队的强制观察递归、冻结启动重调度、延迟 RAF 处理、cancelFrame 递归/失败、最终重启和释放故障通知排序、准备/呈现状态回调以及中止监听器递归。所有 35 个测试在受保护的 `presentation-node-20261024-r1` 运行中通过（共 316 个测试，分布在六个重叠的 Web 合约套件中）。原始 V1 递归诊断被单独保留；后继结果不会重写该失败。

这些测试使用注入的适配器。Rust、WASM 和实际浏览器检查保持独立。纯假适配器测试无法建立真实的 Worker 证明信道、DOM 阶段行为、CanvasKit 提交、GPU 完成、真实浏览器中的资源清理，或任何性能目标。

<a id="validated-frame-ownership"></a>
### 已验证帧的所有权

RPC 客户端执行有界响应遍历和类型图像准入一次。
其成功帧结果会获得一个模块私有的、单次使用的回执，该回执与该具体客户端绑定。会话提供底层客户端及其观察/呈现 RPC 面板；适配器可以消耗该回执并直接使用接收到的结构克隆。注入的 RPC、复制结果、不同客户端或第二个消费者均不能生成或重用该回执，且必须保留完整的验证和复制路径。帧证明、目标、呈现器验证和确认检查仍需执行。延迟响应保留其防御性复制和清理行为。
