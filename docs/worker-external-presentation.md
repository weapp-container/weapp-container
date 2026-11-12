<a id="worker-external-presentation-contract-10"></a>
# 工作者外部呈现合同 1.0

**简体中文** · [English](worker-external-presentation.en.md)


此可选合约将外部帧 Worker 与精确的克隆时间调度事实以及真正的最终呈现确认连接起来。它是一个传输边界；启用它不会安装页面调度器，也无法证明存在 CanvasKit/GPU、浏览器、平台或性能门控。

可恢复的外部绘制表面丢失使用单独的可选
[Worker 绘制表面恢复 1.0](worker-surface-recovery.md) 合同。它在保留重用或需要正常渲染之前撤销原生输入生命周期，同时保留 Worker/会话；新的绘制表面仍需其真实的回执。

<a id="explicit-negotiation"></a>
## 显式协商

调用方必须在加载请求中显式选择：

```js
const loaded = await worker.requestHost('load', {
  renderer: 'external-frame',
  externalPresentation: { version: '1.0' },
})
```

显式manifest/强制渲染器策略也可以选择外部帧。请求的传输必须解析为外部帧。浏览器视图选择将返回`ERR_UNSUPPORTED_CAPABILITY`。

在加载清单或进入 `app.init` 之前，Worker 需要这些宿主导出：

- `external_presentation_contract_json()`
- `last_frame_input_json(revision)`
- `render_target_json(revision)`
- `acknowledge_presentation_outcome_json(revision)`

第一个导出是纯的：它不会创建会话、进入应用 JS 或分配绘制表面。其确切描述是：

```json
{"version":"1.0","consumedInput":"1.0","ackOutcome":"1.0","physicalTarget":"1.0"}
```

缺少导出、不支持的请求或过时的描述符会报错 `ERR_PROTOCOL_VERSION`；没有回退机制，也没有应用程序代码探测来建立合约。协商的加载响应会使用此描述符添加 `externalPresentation`。在没有请求选项的情况下，加载/帧/ACK 响应格式保持与旧版本兼容，Worker 不会探测可选导出。

<a id="clone-time-frame-facts"></a>
## 克隆时帧事实

可选的 `frame` 和 `frame.current` 结果保留其现有的帧、渲染修订版、视图修订版和可选的批次字段。它们还包含：

```js
scheduling: {
  version: '1.0',
  sessionId: '...',
  renderRevision: '...',
  consumedInput: {
    pageId: '...',
    routePath: 'pages/home/index',
    templateRevision: '...',
    viewport: { x: 0, y: 0, width: 375, height: 667 },
  }, // or null
}
```

此元数据仅来自 `last_frame_input_json`，对应于读取该帧时的精确渲染版本（在回执之前）。它从不会来自当前/最新状态、就绪钩子或回执时间的模板版本。空值保持为空值。手动帧、显式数据渲染和已退役的证明无法主张生成页面输入。在附加/就绪/观察者效果之后，模板输入可以合法地比最新状态更旧。

一个密度重绘可以在保留相同消耗输入的同时发布新的渲染令牌。它不会重新评估视图。过时的版本访问将被拒绝。标准十进制字符串保留完整的u64域；不要将其转换为数值。几何形状是与帧的直接f32 JSON值进行比较，而不是独立四舍五入的DOM几何形状。产品调度需要有限的正逻辑尺寸，且尺寸不得超过4096，即使在传统低级外部渲染器接受空目标的情况下也是如此。

`copyExternalFrameScheduling` 在 `worker-runtime.mjs` 中独立验证、复制并冻结这些字段。Worker 结构克隆不保留 Object.freeze：页面接收器必须在将结果提交给调度器之前再次调用辅助函数。该辅助函数不会复制整个渲染帧。

<a id="revision-bound-physical-target"></a>
## 与修订绑定的物理目标

可选 `frame` 和 `frame.current` 还携带 `target`：

```js
{ version: '1.0', sessionId: '...', renderRevision: '...', width: 750, height: 1334 }
```

纯原生 `render_target_json(revision)` 导出读取同一拥有运行时轮次中的已验收帧和渲染缩放，并拒绝过时的修订版本。它不进行像素回读或视图评估。它从后续设备 `pixelRatio` 或最新指标中 never 推导出尺寸。密度变更会产生新的发布修订版本；无效密度保留之前的发布和目标。调度证明中的逻辑视口保持不变。

`copyExternalFrameTarget` 是接收端的验证/复制辅助函数。在结构化克隆之后再次调用它。它需要完全相同的会话/渲染令牌、每边最多 4096 的正整数尺寸，以及最多 16 MiB 的 RGBA 等效绘制表面分配。空的旧式低层帧不满足此产品展示协议。该限制本身并不能证明实际的 GPU 分配或显示成功。

<a id="genuine-final-ack"></a>
## 真正的最终确认回执

可选的 `ack` 请求保持不变：

```js
const final = await worker.requestHost('ack', {
  renderRevision: prepared.renderRevision,
})
```

它的新最终版本与旧版 BridgeBatch API 无关：

```js
{
  version: '1.0',
  sessionId: '...',
  renderRevision: '...',
  acknowledged: true,
  inputEnabled: false,
  requiresRestart: false,
  batch: { messages: [/* complete native effects and diagnostics */] },
  observedState: {/* pure native runtime_state_json result */},
}
```

新的原生/WASM `acknowledge_presentation_outcome_json` 调用实际的运行时 ACK。既不是排队的 HTTP/RPC 回执，也不是伪造的空批次，都不能算作最终 ACK。返回的整个效果/错误批次都会被保留，包括已提交的就绪失败、导航效果和有限轮次故障。重复的 ACK 会返回其真实的新的空批次；之前的效果将永不重放。

故意没有在最终版本中包含 `consumedInput` 或 `scheduling`。ACK 可以观察最新的 templateRevision 作为诊断状态，但不得更新或重新标记准备时的证明。

Rust 单独可以证明 `inputEnabled: true`。在实际 ACK 之后，所有这些都必须保持有效：

- 请求的修订是当前呈现的渲染修订。
- 在此回执之前和之后，相同的非空页面标识/路径都存在。
- 生命周期为活动状态，执行正常，且精确的帧输入证明仍在其原始页面/视口/预览生命周期内。
- 该修订的回执未产生普通错误或重启效果。

`is_current_frame_presented` 单独不足：重复的回执可能在所有者检查前返回，普通的就绪错误也不必导致引擎故障。因此，会为确切的发布修订版本记录一个粘性块，包括首次使用传统回执入口点时的情况。空的重复回执无法清除该记录。真正的新发布修订版本可重新考虑通过相同的健康/运行时验证门栏；保留的密度重绘属于新发布，但不能作为新视图评估的证据。成功加载清单将清除该记录，而加载失败则保留运行宿主的记录。

与最新模板版本的比较不是输入门：普通就绪
setData 创建后续渲染需求，但不会使已发布帧的输入权限失效。隐藏/显示、逻辑缩放、预览退场、页面离开/返回以及执行故障会退场证明，且无法在旧的回执上恢复输入。原生引擎故障或新路由需要 WebView 时将请求重启。策略驱动的传输变更与引擎故障保持独立。

工作者验证真实最终状态，并对其实际观察到的State应用显式渲染器策略。它可以在策略/所有者失败时抑制输入，但无法合成权限。它直接观察一批数据，而不是进行JSON字符串化/解析的往返操作，以保留数值-0和嵌套诊断信息。如果在不可逆的回执后元数据验证失败，错误详情将保留可用的实际批次和观察到的State，而不是假装回滚。一个格式错误的JSON字符串无法提供可恢复的结构化诊断信息。

`copyExternalPresentationOutcome` 对 final 进行独立验证、复制和递归冻结。接收页面必须在结构化克隆之后调用该函数。两个接收方辅助程序在读取提供的字段前都会进行有界的纯数据测量，拒绝在不调用的情况下访问可枚举的属性，并使用现有的每节点/深度 16 MiB 的传输预算。帧像素/资产传输保持不变。

<a id="receiver-integration-and-evidence-limits"></a>
## 接收端集成和证据限制

示例边界使用（不是已安装的产品适配器）：

```js
import {
  copyExternalFrameScheduling,
  copyExternalFrameTarget,
  copyExternalPresentationOutcome,
} from './worker-runtime.mjs'

const frame = await worker.requestHost('frame', {})
const scheduling = copyExternalFrameScheduling(frame.scheduling, {
  sessionId: worker.sessionId,
  renderRevision: frame.renderRevision,
  frame: frame.frame,
})
const target = copyExternalFrameTarget(frame.target, {
  sessionId: worker.sessionId, renderRevision: frame.renderRevision,
})
// The owning presenter submits these exact frame commands at target size before ACK.
const wireFinal = await worker.requestHost('ack', { renderRevision: frame.renderRevision })
const final = copyExternalPresentationOutcome(wireFinal, {
  sessionId: worker.sessionId,
  renderRevision: frame.renderRevision,
})
// Admit scheduling and final to a scheduler only within its unchanged hard fence.
```

此更改提供了网络边界和编写的测试。它并未集成页面外部呈现器、替换运行中的模拟器、安装分阶段的 DOM 呈现，或证明任何性能门限已被通过。原生真实引擎测试和假宿主 Worker 协议测试是独立的：假测试无法证明 Rust、WASM、浏览器或 GPU 行为。根级集成必须先运行原生/Node/WASM 检查和真实拥有浏览器的呈现/竞争测试，才能报告验收。
