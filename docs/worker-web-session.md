<a id="workerwebsession-owner"></a>
# WorkerWebSession 所有者

**简体中文** · [English](worker-web-session.en.md)


此异步所有者与静态Worker产品入口以及旧版同步嵌入API一起使用。自动浏览器开发监视功能在可信启动、管理器和精确关闭链集成之前保持禁用。执行证据与特定源版本绑定；仅模块可用性无法证明浏览器、GPU、性能或七主机合规性。

```js
const session = new WorkerWebSession({
  surfaceRoot,
  onBatch(batch) { /* synchronous diagnostics/effects */ },
  onState(status) { /* runtime and presentation readiness are distinct */ },
  onError(error) { /* replace the owner explicitly when required */ },
})
await session.load({
  workerUrl: './runtime-worker.mjs',
  indexUrl: './pack-index.json', indexSha256,
  engine: 'quickjs', renderer: 'auto', rendererPolicy: { mode: 'manifest' },
  viewport: { width: 375, height: 667 },
  rendererAssets, // full pinned runtime-config schema, only used externally
})
const actualFinal = await session.request('api.call', payload)
await session.setLogicalViewport({ width: 667, height: 375 })
await session.setRenderScale(2) // external-frame only; no View evaluation
await session.setVisible(false)
await session.close()
```

`load` 报告成功验证的运行时启动。其返回值包含实际的调度器状态，而不是像素、输入就绪或 GPU 完成的声明。`status.presentation` 和 `status.inputEnabled` 暴露当前的呈现状态。没有同步运行时句柄、公开的原始 Worker/RPC 获取器、主线程应用程序 WASM 导入、原生 HTTP 会话或回退分支。实际的默认值为 WorkerRpcClient、WorkerBridgeTransport、PresentationScheduler、WorkerDomAdapter、WorkerCanvasKitAdapter 和 attachSurfaceInput。V8/软件请求在此阶段明确失败。

受信任的嵌入器可以在 `load` 中设置 `viewExecution: { batchTimeoutMs: 250 }`。
Worker 仅接受 1 到 5000 毫秒之间的整数；省略该设置则保留原生的 50 毫秒批处理默认值。此设置适用于隔离的 View 域，但仍会因活动的 AppService 转换和桥接超时而缩短。它不扩展 `engineExecution.turnTimeoutMs`（默认值为 250 毫秒）、单独的启动预算，或绝对的加载截止时间。请在主机代码中保留这些产品设置；客体数据和 URL 查询参数无法更改它们。

<a id="admission-and-ownership"></a>
## 入学与所有权

一个 `load` 调用会在任何 await 之前声明所有者，创建一个全新的 Worker 和一个桥接器，并在重复时返回相同的 load Promise。在执行替换前，必须单独等待旧所有者的关闭。单独的 `BrowserDevOwnerManager` 实现了这种本地顺序性；浏览器开发 CLI/启动集成以及自动渲染器家族替换仍保持为独立的门禁。

`admitPack` 默认使用 worker-admission-loader.mjs 中的 `admitWorkerPack`。其精确的注入合约为：

```js
admitPack({ indexUrl, indexSha256, indexSize?, route?, rendererPolicy, signal })
// -> version 1.0, resolved route, rendererPolicy, transportBackend,
//    declaredProfile, effectiveProfile,
//    provenance { indexSha256, manifestSha256, integrityRoot }, manifest?
```

它必须在不执行任何应用的情况下验证已固定的索引/清单、路由和策略。工作者独立验证相同的固定项。预检将选择负载请求是否可以加入 `externalPresentation`；实际的加载固定项、后端、声明/有效配置、路由、真实的QuickJS以及协商的合同必须全部一致。不一致将关闭此确切的所有者；它将永不尝试另一个渲染器/引擎或主张先前应用效果已回滚。

`loadRendererAssets` 默认为 `loadPinnedCanvasKit`，仅在实际的外部帧加载被允许时运行：

```js
loadRendererAssets({ owner, loadResult, rendererAssets, signal })
// -> { version:'1.0', owner, CanvasKit, fontData:ArrayBuffer,
//      presenterOptions?, dispose() /* stable actual last-use barrier */ }
```

加载器验证现有的六个固定渲染器资源。它必须拥有并清理部分失败情况，并最终决定中止。拥有者会验证返回的身份，在检查取消之前采用延迟返回的租约，并在适配器最后一次使用后释放该租约。加载器的页面作用域绘制WASM缓存与应用执行及每个拥有者的字体所有权是独立的；一个拥有者关闭并不会声称销毁共享的CanvasKit模块。构建包描述符的修正是一个独立的必要候选项，不会被该拥有者默默修复。

可选的工厂注入为节点草案或显式嵌入提供同名的RPC/桥接/调度器/适配器合约。工厂在抛出前必须自行清理，且任何异步工厂在中止后必须完成结算。任何使用资源的回调均不得在其最后一次使用屏障之后安排工作。

<a id="ordered-observations-before-effects"></a>
## 效果发生之前的时间顺序观测

桥和两个适配器共享一个观察到的RPC前端，该前端具有完全相同的不可变纪元/会话身份，并且没有关闭/终止方法。在成功时消耗原始的外部观察结果，在遇到传输错误或延迟最终结果时也消耗这些结果，然后将该结果/错误/信封返回给实际消费者。它从不生成页面侧的观察序列，也不会复制普通桥接响应接收。

一个更早/相同的时间观察无法覆盖当前状态。相等的原始序列可以合法地伴随不同的定时器批次；事件接收ID会去重实际事件，而每个独立的真正批次仍会到达唯一的桥一次。保留一个最新观察和32个诊断信息；不会缓冲无界的启动事件日志。消费者回调是同步的；事件回调从不等待RAF、呈现/资源或另一个RPC。

该候选人需要附上制作合同：

- 启动批次负载：`phase:'startup'`，无观测，仅在初始有序加载观测之前；
- 生产批次负载：`phase:'live'`，包含原始同轮观测；
- 污染负载：原始完整观测。

没有此合同的较老生产者不兼容。缺失/错误的实时元数据会先冻结并出错，然后将其实际批次保留给其真正的消费者。它不会重新标记一个较老的快照，也不会重放一个事务以制造顺序。

预留的定时器故障可能携带有限的诊断committedResult数据，其`effectDelivery:'unconfirmed'`且明确省略了观察值。该所有者会冻结并报告其原始嵌套错误/详情。诊断数据绝不会作为新桥接效果重新播放，也不会被当作呈现/确认处理。

原生成功在需要渲染器替换进行观察时仍被视为实际成功。页面所有者会冻结/故障并暴露实际提交的导航最终结果；它不会将该最终结果转换为回滚，也不会再次执行该操作。一个失败的桥接/视图.abort 外层调用，所有者会保留其真实的保留批次到其事实/诊断接收器中，且不会将其成功状态与仍在待处理的内层请求相关联；原始外层错误必须拒绝该请求。直接的指标/退役结果没有此类待处理内层关联。帧/确认保留效果归属于CanvasKit适配器的错误消费者，从而避免了重复批次交付。正常的视图.退役控制结果也会到达所有者的效果接收器；清理RPC仍然可用。

<a id="presentation-metrics-and-input"></a>
## 演示、指标和输入

实际的适配器/调度器执行所有准备、证明、发布和ACK检查。拥有者会用其自身的活跃/可见/本地度量修订门控包装调度上下文，因此在拥有者故障后，任何延续都无法启用输入，包括即使成功交付了原生ACK但观察结果存在错误的情况。普通的渲染失败可以使用 `retryPresentation` 重试；严重的拥有者故障需要显式替换。

DOM 借用唯一的桥；其 DomSessionClient 拥有真实的 DOM 输入/几何信息和分阶段事务。拥有者在调度器观察和唯一桥接批次入口之前调用 adapter.receiveObservation。它不会调用 adapter.receiveEvent，不会传递 adapter.onBatch，不会创建第二个传输，也不会附加第二个 DOM 输入辅助工具。不支持的保留 DOM 绘图保持显式。

CanvasKit 表面安装会释放其先前拥有的输入辅助程序，然后在确认/输入启用前附加新的辅助程序。坐标始终使用权威的逻辑视口和表面生成值，而不是物理画布的宽度。真实的适配器输入权限和当前所有者/页面/视口/生命周期门控输入；仅凭收据和调度器状态无法授权。会话会根据已安装证明中的逻辑视口独立地调整其拥有的画布 CSS 盒子大小。嵌入器会对借来的外层表面根应用显示缩放，而不是更改渲染密度。

`setWindowMetrics` 接受完整的原生形状，包括模拟的 pixelRatio、屏幕大小、状态/屏幕顶部、方向以及可选的安全区域。逻辑缩放基于该设备度量配置；渲染密度从不覆盖其 pixelRatio。度量和生命周期命令在拥有者控制通道上序列化。待处理的度量在任何队列或回调之前安装持久的本地版本。它们同步重置 CanvasKit 联系人，使 DOM 客户端的实际本地权限失效，冻结其呈现器，并暂停调度器，而不会改变任何原生观察或表面生成。共享的发送边界控制 `event.batch`、`view.events` 和 `view.geometry`；DOM 输入还检查确切的接受原生键和当前本地权限。呈现/确认/清理操作保留各自的通道。

每个准备尝试都通过当前/发布版本捕获相同的拥有者修订版。
只有最新的成功指标最终版本可以重新打开准备，从不输入。
调度器恢复会保持已接受的空值，并请求实际发布，包括
对于相同值/无操作指标操作。匹配的真正启用
呈现最终版本会关闭该修订版的输入栅栏。更早的排队完成、
队列计数器清理、HTTP/RPC收据和过时的确认无法关闭它。无操作
指标会故意获取一个新模板发布；物理缩放保持在保留的绘制路径，
不会触发此逻辑指标事务。

DOM本地权威修订是一个独立的单调客户端取消令牌；
原生表面生成仍完全来自原始工作线程状态。
严格确认会发布其稳定的Promise，并同步记录一个真实的确认作为已禁用的确认候选者，然后再等待前驱的最后使用。
其最终激活以及每次后续的几何/事件条目都会重新检查持久输入保护。一个通常已退化的真实确认在输入被禁用时仍会保留；它不会被转换为资源清理错误或人为制造的当前呈现成功。真正的清理错误和超时仍然会失败。

原生硬生成也退化了实际的键控权限。一个失败的度量回调可能已经提交了维度；其最终观测值被保留，所有者保守地要求替换，从不因为 Promise 被拒绝就恢复旧的坐标。

Hide 在分发前撤销本地输入。Show 必须使用真实的原生生命周期，并获取一个真正有效的发布/输入结果。VisibilityChange 和 pagehide 监听器在关闭时被拥有并移除。浏览器页面销毁可能会阻止异步操作的优雅完成；显式关闭是可审查的屏障。

<a id="stable-close-and-remaining-gates"></a>
## 稳定闭合并保持门关着

相同的紧密承诺在中止/冻结钩子可以重新进入之前被发布。它：

1. 退掉本地输入，中止所拥有的加载/公共等待，并移除所拥有的监听器；
2. 等待底层加载任务，以便延迟的租约/适配器被拥有并清理（它不等待公共加载 Promise，后者本身可能等待关闭）；
3. 关闭调度器，包括适配器取消/精确远程退订，进行中释放和适配器销毁，而 RPC/桥接仍处于可用状态；
4. 在实际最后一次使用后，释放所拥有的输入辅助工具和渲染器租约；
5. 销毁桥接，等待精确的 RPC 关闭/终止，结算排队的拥有控制，并仅移除其专用的子挂载。

原始错误和清理失败仍然存在；在先前的清理错误之后，后续步骤仍会继续运行。仅因为本地表面已被释放，并不能证明远程传输失败时运行时卸载是成功的。没有使用全局 Worker、浏览器、进程或用户根目录的清理。

实际的关闭结果现在具有 `version: '1.0'`，不可变的 `owner` 以及捕获的 `rpcIdentity: {workerEpoch, sessionId}`，同时还有 `closed`、`workerClosed`、`ownedMountRemoved` 和 `workerFinal`。当未分配时，身份字段明确为 null；一个创建的 RPC 可以在打包准入确立 owner 元组之前就存在。被取消的已准入负载即使没有返回任何公共运行时就绪结果，也会保留其元组。这些情况仍然意味着会话是通过其真实的屏障关闭的，而不是一个 `never-constructed` 结果。

开发经理会将实际结果与其原始站点以及所有本地已知的元组进行比对，然后再报告浏览器报告的关闭状态。Rust使用带类型的形状来完成此确认；仅形状验证本身并不赋予销毁权限。开发HTTP负责人将继续拒绝成功关闭报告，直到可信的启动节点和精确的实际管理链被连接起来。

Node 合约使用受控的 RPC/适配器/调度器工作加上实际的桥接和管理器。关闭身份切片同时运行会话、管理器和 HTTP 客户端合约；这些合约不会执行实际的工人、浏览器、展示器或 GPU。历史静态工人证据被单独记录在 [实现状态](dual-renderer/implementation-status.md) 中。仍需的开发门禁包括可信的启动链与实际管理器/工人关闭链、保留站点替换、浏览器竞争/输入/关闭证据以及真实的输入到展示的时序。该切片既未建立性能，也未实现七主机完成。


<a id="complete-surface-and-host-layout"></a>
### 完整表面与宿主布局

`setWindowMetrics()` 的 `windowWidth/windowHeight` 描述实际渲染 View 的完整逻辑尺寸。
保留背景和画布的完整覆盖，在页面内部为可点击控件及滚动内容应用安全布局；不要先用安全区裁小画布。
可选 `hostLayout` 为容器扩展，结构如下：

```js
await session.setWindowMetrics({
  ...actualWindowMetrics,
  hostLayout: {
    version: 1,
    safeInsets: { top: 0, right: 84, bottom: 34, left: 0 },
    verticalBarEdge: 'right',
    reservedRegions: [
      { id: 'camera', kind: 'occlusion', x: 867, y: 0, width: 84, height: 56 },
    ],
  },
})
```

示例数值用于说明字段，生产值必须来自当前 View 的系统观测。`verticalBarEdge` 是宿主解析后的物理边缘；
`reservedRegions` 仅包含当前有效区域，坐标与边距均为 View 局部逻辑单位，框已包含系统提供的 margins。
完全展开时应移除无效折叠分隔。旧 `safeArea` 仍使用屏幕固定坐标，不能直接作为当前 View 的 padding。
省略 `hostLayout` 会清除旧布局；`setLogicalViewport()` 在改变尺寸时也会清除无法重新观测的局部布局。

页面使用 `wx.getWindowInfo().hostLayout` 同步读取，并通过
`wx.onHostLayoutChange(callback)` / `wx.offHostLayoutChange(callback)` 订阅和移除通知。
这两个 API 是容器扩展，必须在 manifest 与受限策略中明确声明。
通知参数为 `{ hostLayout }`；清除时值为 `null`。
只改变侧栏或保留区域时会撤销旧触摸和呈现权限，提交同步查询值，再通知页面；不会触发 `onResize`。
尺寸变化仍通过现有 `onResize` / `wx.onWindowResize` 通知。

`status.windowMetrics` 是只读、递归冻结的最近成功提交快照；它不代表新画面已经可交互。
等待本次 `status.metricsFence.revision` 对应的 `phase === 'open'`、新的呈现回执和
`status.inputEnabled === true` 后再解除宿主操作锁。旧请求的完成结果不能解除新请求的锁。

<a id="full-surface-and-host-layout"></a>
### 完整的表面和宿主布局

`windowWidth/windowHeight` 覆盖完整的渲染视图。保持背景和画布的全尺寸，并使用可选版本-1 `hostLayout` 保护内容和控件。其内边距和活动保留区域的边框使用视图本地的逻辑坐标；边距已包含在内。`verticalBarEdge` 是一个解析后的物理 `left`、`right` 或 `none`，与语言方向无关。旧版 `safeArea` 保持其固定屏幕坐标的含义。省略 `hostLayout` 将清除该设置；仅包含尺寸的 `setLogicalViewport()` 在尺寸变化时会清除本地布局，因为它无法重新测量宿主。

容器扩展 `wx.getWindowInfo().hostLayout` 会暴露已提交的值。
在订阅前，需在清单和限制策略中声明 `wx.onHostLayoutChange` 和 `wx.offHostLayoutChange`。回调接收 `{ hostLayout }`，当被清除时值为 `null`。仅布局变更会终止旧的触摸/呈现权限，但不会触发重绘。在成功获取度量值后，可获得不可变的 `status.windowMetrics` 快照；交互还要求有新的呈现并匹配 `status.metricsFence.revision` 且处于打开状态，同时 `status.inputEnabled === true`。
