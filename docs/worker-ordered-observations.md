<a id="worker-ordered-observations-10"></a>
# 工作者有序观察 1.0

**简体中文** · [English](worker-ordered-observations.en.md)


这是一个可选的 Worker/运行时合约。它不会连接产品入口，安装呈现器，或建立浏览器/GPU/性能验收。

<a id="negotiation-and-legacy-compatibility"></a>
## 协商和向后兼容性

加载时启用 `observation: { version: "1.0" }`。缺失表示使用传统方式：
加载/状态/帧/ACK/批次形状和脏事件不包含观察字段，且
不会探测新的宿主导出。外部呈现 1.0 和观察 1.0 是独立选项；Worker 产品应为外部帧协商两者。

在 `app.init` 之前，Worker 需要：

```js
host.observation_contract_json()
// exactly { version: '1.0', inputLifetime: '1.0' }
host.observation_state_json()
// { version:'1.0', inputLifetimeRevision:'0', state:<legacy runtime state> }
```

握手是纯的，不需要加载会话。状态导出是纯的，在加载清单之后、应用 JS 之前进行验证。缺失/过时的导出、无效的请求版本和缺失的生命周期令牌会明确失败。原始 `runtime_state_json` 导出/结构保持不变。在加载之前的状态导出返回 NotLoaded。

成功加载添加了：

```js
observationContract: {
  version:'1.0', sequence:'u64', surfaceGeneration:'1.0', inputLifetime:'1.0',
},
observation: {
  version:'1.0', sequence:'1',
  state: {
    // all pure runtime/policy/fault observations, plus:
    owner: { workerEpoch, sessionId, packSha256, transportBackend },
    surfaceGeneration:'1', inputLifetimeRevision:'...',
    viewport:{ x:0, y:0, width:375, height:667 },
  },
}
```

packSha256 是已验证的 pack-index 摘要，而不是任意的清单摘要。
初始化状态（已创建，启动/页面之前）不会生成公共序列或代。初始捕获在完整加载验证之前是临时的；启动失败将丢弃该捕获，不启用普通工作，并且不会启动定时泵。
一个 Worker/会话不能重新加载。只有在成功准入后，通过创建新会话才可重置命名空间。

<a id="one-owner-lane-original-sequences"></a>
## 一个所有者通道，原始序列

序列化的 Worker 通道仅分配标准的 u64 字符串。每个已更改的权威快照都会获得下一个检查序列。空操作状态请求会重用现有序列。页面侧响应到达顺序、每帧更新（RAF）、配置修订和视图修订从不生成序列。

在执行了一个原子宿主调用后，最终刷新会读取纯原生状态和长生命周期令牌。这包括桥接转/批次、帧准备、保留帧读取、指标、密度、ACK效果、定时器和错误路径。原始结果/错误/批次会被保留；刷新不会重新播放应用回调。成功响应会在原有字段基础上增加 `.observation` 字段。错误响应则在原有错误字段基础上增加 `.error.observation` 字段。脏事件会携带带有该精确快照/序列的 `.payload.observation`。加载/状态/帧/ACK/指标/缩放等都可以引用同一序列：该序列会被复用，而不是为每条传输路径重新编号。

运行时/拥有者/策略通道中的选入通道故障会推迟单个预留故障的发布，直到最终刷新，然后将该故障观察结果传递出去。
这样可以在无需正常事件信用的情况下，传递已确认的定时器错误状态。
故障发布仍会冻结消费者；它从不授予呈现或输入权限。
仅准入类错误/已取消的队列工作会重用最后一次真实的快照，从不进入原生状态或推进计数器。状态请求保留诊断用的准入控制。
关闭时，采样会在处置前提交卸载状态，停止该通道，从不允许可延迟的响应重新激活它。

copyOrderedObservation 在结构化克隆之后执行有界的普通数据复制/验证/冻结，并保留源序列的精确顺序。页面所有者必须将其调度器提供更新的序列；延迟响应无法覆盖更新的脏/故障观察。在通过兼容性辅助函数传递其内部批处理或确认之前，必须先观察外部响应元数据。onEvent 必须保持及时，并且不得等待呈现。

如果在不可逆操作之后刷新本身失败，响应将保留原始错误详情或已提交结果加上观察刷新错误，且由所有者负责。它不会假装回滚。原始批次仅在完整响应的现有字节/节点/深度预算范围内得到保留；超大响应只能传递有限预算错误，而无法保证完整批次。

<a id="logical-generation-and-native-lifetime"></a>
## 逻辑生成和原生生命周期

surfaceGeneration 从 1 开始，如果逻辑硬签名发生变化（当前页面 ID/路径、逻辑视口、活动/非活动权限或原生输入生命周期令牌），则递增 1。原生令牌的变化会捕获隐藏的同轮次 hide/show 以及 push/pop 操作返回旧页面的情况。令牌的 delta 不用于生成 delta。密度、CSS 缩放、普通数据、ready setData、保留重绘和诊断捕获不会改变逻辑生成值。但由于数据/渲染状态发生变化，它们可能改变观察序列。

会话拥有输入生命周期修订号：Option<u64>，初始值为Some(0)。硬性退休使用checked_add。None表示永久耗尽：不会溢出，旧证明或带密钥的输入可能恢复；引擎轮次准入失败。新的纯状态导出报告为null，工作程序进入重启所需状态。工作程序序列和生成计数器也检查u64边界；耗尽会故障并影响所有者，但不会生成重用令牌。最后一次真实的观测可以伴随终端故障，但不会发布伪造的下一快照。

<a id="hardsoft-invalidation-call-site-inventory"></a>
## 硬/软无效调用位置清单

以下清单涵盖了已固定运行时源代码，包括未更改的 components.rs 调用者。行号在根级格式化时可能会发生偏移；函数和原因用于标识每个调用位置。

| 调用位置 | 类 | 原因 |
| --- | --- | --- |
| browser_view::invalidate_browser_page -> invalidate_browser_presentation | 页面为当前页面或拥有帧/浏览器证明时操作较复杂 | 缓存的 PageId 无法复活已退化的权限；无关的后台页面操作无效果。 |
| browser_view::retire_browser_contacts_before_host_mutation -> invalidate_browser_presentation | Hard | 显式在联系结算后撤销宿主生命周期。 |
| browser_view::retire_browser_preview unhealthy branch -> invalidate_browser_presentation | Hard | 缺少 JS 执行的预览撤销。 |
| browser_view::retire_browser_preview_within_turn storage-sync error -> invalidate_browser_presentation | Hard | 显式退场在同步失败的情况下仍然有效。 |
| browser_view::retire_browser_preview_within_turn normal branch -> retire_browser_contacts_before_host_mutation | Hard | 显式绘制表面租赁回收。 |
| browser_view::prepare_browser_view_within_turn after contact settlement | Soft, now invalidate_browser_candidate | 普通准备替代图形权限；不生成坐标/生命周期。 |
| browser_view::handle_browser_operation VIEW_PREPARE 非静止效应 | Soft，现在作废浏览器候选 | 仅撤销不完整的候选；真正的硬效应/故障已通过其自身边界递增。 |
| lib::replace_manifest changed manifest -> retire_browser_contacts_before_host_mutation("manifest-replaced") | Hard | New graph/resources retire prior input lifetime. |
| lib::app_service_mut normal -> retire_browser_contacts_before_host_mutation("host-state-mutated") | 高 | 未受限制的变更可以替换页面/生命周期，且本地计数器相同。 |
| lib::app_service_mut retirement failure -> invalidate_browser_presentation | 强制回退 | 即使回调失败也要撤销；令牌只需与旧值不同，无需每次 API 调用都递增一次。 |
| lib::renderer_mut -> invalidate_browser_presentation (new) | Hard | 无限制借用可以替换 renderer/revision 命名空间。产品保留路径必须使用已知的会话 API。 |
| lib::notify_window_metrics_within_turn changed logical viewport -> invalidate_browser_presentation | 严重 | 缩放钩子之前触发的逻辑视口变化，包括抛出的回调。 |
| lib::handle_lifecycle Hide/Unload -> invalidate_browser_presentation | Hard | 即使后续钩子失败或同一批次再次显示，前台输入生命周期也会结束。 |
| lib::unbind_page -> invalidate_browser_page | Hard if owned/current | 页面离开/销毁。 |
| lib::invoke_page_hook_for_id onHide/onUnload -> invalidate_browser_page | Hard if owned/current | 生命周期路径，包括早期失败。 |
| lib::invoke_page_hook_for_id_with_index onHide/onUnload -> invalidate_browser_page | Hard if owned/current | 具体实例路径；重复撤销是安全且单调的。 |
| components::invalidate_component_page -> invalidate_browser_page | 高风险，如果为当前拥有者 | 未完成的管理图确认会使之前的接收方不安全。 |
| components::dispose_page_components -> invalidate_browser_page | 有风险如果为当前拥有者 | 被销毁的组件/事件图无法恢复。 |
| engine_turn::record_execution_fault -> invalidate_browser_presentation | Hard | 中断的域没有呈现/输入权限。 |
| Session::set_render_scale | 既不 | 已知的保留重绘保持输入令牌和克隆证明。 |
| Session::capture_render_snapshot | 既不 | 诊断回读不会替代已验收的布局/输入。 |
| 普通 setData/data patch，浏览器几何/许可失败，某键操作中止 | 既不 | 模板/交易变更使用现有精确键/通过退场语义；不发明硬令牌。 |

invalidate_browser_candidate 保留旧的像素/资源用于诊断，撤销待处理/旧事件的授权，并如以前一样清除帧证明。它故意不推进硬令牌。Native prepare 在取消/评估之前捕获硬生命周期，并在任一阶段期间若发生变化则拒绝，即使页面返回相同的标识。准备之后的硬效果已通过现有的精确运行时密钥检查退役待处理密钥。

<a id="dom-generation-admission"></a>
## DOM 生成准入

在自愿启用的浏览器视图通道中，view.prepare必须提供当前的Worker绘制表面生成版本。view.prepare.commit、view.presented、view.geometry和view.events必须在其精确键中携带匹配的生成/会话/页面/配置信息。过时的操作在进入WASM之前将失败。精确的中止/回收仍可用于清理。未来或猜测的生成版本不予接受。

每个原子原生桥调用仅允许一个键控表面操作。包含键控 DOM 工作的混合批次将被拒绝，而不进行拆分或执行：该批次中的 hide/show 或 leave/return 早期操作不得使后续的过时键看起来有效。普通批次保留其原生不可分割的语义。在准备阶段出现硬性效果将被原生拒绝，或通过最终观察结果体现；后续的老一代提交/输入将无法进入。DOM 适配器必须在发布候选之前处理该观察结果。

这是一个线程/运行时边界。它不绑定实际的 DOM 或 CanvasKit 适配器，不实现外部事件生成的隔离，也无法证明页面级呈现器/所有者清理流程。这些仍属于产品集成门禁。

<a id="authored-verification-and-limits"></a>
## 作者验证和限制

原生测试用例涵盖相同原子批次的隐藏/显示以及推入/弹出返回到旧页面，重复真实 DOM 准备而无需硬令牌循环，准备就绪的 setData/密度/诊断捕获，失败的尺寸调整（带有已提交的尺寸/令牌）和恰好一个回调，纯导出协商，以及终端原生溢出。

假宿主 Node 测试用例涵盖主动启用的通信链路，所有观察结果路径，原始序列重用，过时的 DOM 生成版本，混合批次拒绝，定时器故障/错误刷新，启动准入，u64 精度和共享 DAG 冻结行为。

这些测试在根执行它们之前都是草稿。没有构建、测试命令、WASM、浏览器、服务替换、GPU 或性能验收在候选作者编写期间运行。产品入口连接和真实保留站点验证仍为独立需求。
