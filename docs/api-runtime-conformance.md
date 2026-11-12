<a id="appservice-api-semantic-regression"></a>
# AppService API 语义回归

**简体中文** · [English](api-runtime-conformance.en.md)


`container-core` 和 `container-runtime` 在宿主无持久化存储时提供一个
**session-scoped memory provider**。它只在 `ContainerManifestV1.capabilities`
显式声明对应 `wx.*` 项目为 `full` 或 `partial` 时开放；宿主配置会再取两者
的较低等级。这样 `wx.canIUse` 的结果与实际 dispatch 门禁保持一致。

<a id="storage"></a>
## 存储

`wx.setStorage`、`wx.setStorageSync`、`wx.getStorage`、
`wx.getStorageSync`、`wx.removeStorage`、`wx.removeStorageSync`、
`wx.clearStorage`、`wx.clearStorageSync`、`wx.getStorageInfo` 和
`wx.getStorageInfoSync` 共享同一个会话内
`MemoryStorage`。QuickJS/V8 的本地存储镜像通过批量
`storage.patch.batch` effect 合入 AppService；每次执行脚本前恢复宿主快照，
因此 bridge 写入、模块顶层写入、回调写入和异常前的写入都可相互观察。
所有同步和异步入口都检查同一份 capability，禁止 `canIUse` 返回 false 后继续写入。
`set`、`remove`、`clear` 都产生 `RuntimeEvent::StorageChanged`。

JSON 值使用 `snapshot()` 保存；需要保留 JavaScript `undefined` 时，宿主应使用
`snapshot_state()` / `restore_state()`。这个版本化前的内部快照用 `values` 与
`undefinedKeys` 区分显式 `undefined`、JSON `null` 和缺失 key，不把哨兵对象暴露给小程序。

`getStorageInfo*` 返回排序稳定的 `keys`、以 KiB 向上取整的 `currentSize`
和 10 MiB 的 `limitSize`；currentSize 按每个 `[key, value]` JSON pair 的
UTF-8 字节数计算，异步形式还带 `getStorageInfo:ok` envelope 并遵守
success/fail/complete 回调和 Promise 双形态。

同步读取遵循微信和 `@mpcore/simulator` 的缺失值约定：
`wx.getStorageSync(key)` 在 key 不存在时返回空字符串 `""`，不会抛出
`data not found` 异常。若调用方显式写入 `undefined`，该值仍保持
`undefined`，因此实现通过存储键存在性而不是返回值判定缺失。

请求示例：

```json
{"name":"wx.setStorage","key":"greeting","data":{"text":"hello"}}
```

响应的 `result` 和顶层字段均保持批量 bridge 的 JSON 形式。异步读取不存在的 key
返回 `ok: false`、`found: false`、`data: null` 与结构化
`ERR_INVALID_REQUEST` / `wx.getStorage:fail data not found`；JavaScript 端执行
fail/complete 并拒绝 Promise。同步读取的 `result` 是原始值，缺失时为 `""`。
同步 set/remove/clear 的 `result: null` 表示 JSON 边界上的 undefined 返回值。
显式保存 undefined 仍是成功读取，bridge 以 `found: true`、`undefined: true`
标记，JavaScript 端返回真实 undefined；null 与缺失 key 分别处理。

<a id="launch-options"></a>
## 发布选项

`app.init` 的 `launchOptions` 会在 session 中保存为同一份 JSON 对象，并在
App.onLaunch、后续 App.onShow、`wx.getLaunchOptionsSync` 以及
`wx.getEnterOptionsSync` 中复用。模块在
`app.init` 载入阶段调用同步 API 也会看到该快照；重复的 `app.init` 只有在显式
传入新对象时才更新它。缺省快照保持微信常见的 `{ path: "", query: {},
referrerInfo: {}, scene: 1001 }` 形状，非对象输入会返回
`ERR_INVALID_REQUEST`。

<a id="device-snapshot"></a>
## 设备快照

`wx.getBatteryInfo` 和 `wx.getBatteryInfoSync` 通过同一个 typed host provider
边界返回 `{ level, isCharging, errMsg }`，其中 `level` 固定在 `0..100`。
异步形式使用 `getBatteryInfo:ok`，同步形式使用 `getBatteryInfoSync:ok`，且同步
调用在模块求值前由 runtime 注入 provider 快照，不产生 bridge 请求。默认
`SandboxProvider` 使用可复现的 `100%`、非充电快照；测试和宿主适配器可以
通过 provider 的电池配置注入其他状态。请求在 provider 入口统一检查
deadline 和 cancellation，过期或取消时返回 `ERR_TIMEOUT` 或 `ERR_CANCELLED`，
不会伪造成功结果。真实设备 provider 应从系统电池服务提供同样字段，并在
没有系统能力时让 capability 协商结果降为 `unsupported`。

`wx.getScreenBrightness` 和 `wx.setScreenBrightness` 共享同一个 typed provider
状态。`value` 必须是有限的 `0..1` 数字；读取返回
`{ value, errMsg: "getScreenBrightness:ok" }`，写入返回
`{ errMsg: "setScreenBrightness:ok" }`。设备权限、deadline 和 cancellation
在 provider 入口统一校验，sandbox 默认亮度为 `1`，宿主可以注入真实显示服务
并在不支持时将 capability 协商为 `unsupported`。

<a id="timers"></a>
## 定时器

`setTimeout`、`setInterval`、`clearTimeout`、`clearInterval` 使用
`TimerScheduler`。调度器不创建 native 线程，由宿主在事件循环中调用
`Session::poll_timers(now_ns)`；返回的单个 `event.batch` 包含所有到期 timer
及其 `timerId`、`kind`、`firedNs`、`callbackId`。一次 poll 对 interval 只产生
一次 firing，并从当前 host clock 重新计算下一次 deadline，避免暂停后出现
无界追赶批次。清除未知 timer 是幂等的，并返回 `cancelled: false`。

真实 QuickJS/V8 中的全局定时器由所选引擎保存 callback。相同的
`poll_timers` 入口按毫秒 host clock 批量执行 JS timer，清空 microtask 并提交
storage、setData 和 API effects；trace 分别标记为 `quickjs.timer` 和 `v8.timer`。
回调执行前同步最新宿主 storage 快照，因此 bridge 写入后立即触发的定时器
不会读取旧镜像。没有到期回调时不发出空的 engine timer trace。

<a id="capability-and-error-contract"></a>
## 能力与错误合约

`wx.canIUse` 从 manifest 与宿主 capability 的协商结果计算，未知或
`unsupported` 项返回 `result: false`。其它 API 在同一状态下返回
`payload.error.code = "ERR_UNSUPPORTED_CAPABILITY"`；不会静默返回空值。

<a id="sharing"></a>
## 共享

`wx.shareAppMessage` 和 `wx.shareTimeline` 都通过同一批量 provider 边界传递
分享选项。QuickJS/V8 facade 在进入 bridge 前拒绝 `null`、数组和其它非对象
参数并返回 `ERR_INVALID_REQUEST`；sandbox provider 继续校验可选的字符串字段、
`extraData` 对象以及 `menus` 字符串数组，过期、取消和显式 `share` 权限拒绝
沿用统一错误码。成功结果只包含公开的 `{ errMsg: "wx.share*:ok" }` 结构，
provider 另外保存一个 typed `ShareRequest` 快照供 conformance 和 native host
适配器读取。sandbox 不打开系统分享面板，也不把请求记录当作用户已完成分享；
真实平台 provider 需要自行接入系统分享生命周期。

<a id="transient-ui-and-page-controls"></a>
## 临时 UI 与页面控件

`wx.showToast`/`hideToast`，`showLoading`/`hideLoading`，`showModal`，`showActionSheet`，`pageScrollTo` 和 `setNavigationBarColor` 跨越了与网络和设备 API 相同的类型提供者边界。确定性沙箱在不打开原生窗口的情况下记录了最新的叠加层、滚动和导航栏状态。它验证了公共选项的形状，并返回文档记录的结果封装（模态的`confirm`/`cancel`，操作面板的`tapIndex`），因此主机可以在保留批处理桥接语义、截止时间、取消和销毁的前提下替换提供者实现。这些 API 在每个主机提供用户操作时间、原生叠加层和可访问性证据之前将持续为`partial`。

<a id="selector-query"></a>
## 选择器查询

QuickJS/V8 将每个 `NodesRef` 选择及其回调保留在隔离区内。
`boundingClientRect`、`scrollOffset`、`fields` 和 `node` 的追加操作；
`select`/`selectAll` 单独操作不会将工作追加到现有操作批处理中。
一个非空的 `exec()` 仅发出一个 `wx.createSelectorQuery` 桥接请求，而不是为每个引用或匹配节点发出一个请求：

```json
{
  "name": "wx.createSelectorQuery",
  "queries": [
    {
      "selector": ".card",
      "target": "node",
      "all": true,
      "operation": "boundingClientRect",
      "fields": null,
      "scopeId": null
    },
    {
      "selector": "#scroll",
      "target": "node",
      "all": false,
      "operation": "scrollOffset",
      "fields": null,
      "scopeId": null
    }
  ]
}
```

较早的直接桥接形状（`selector`，`all`，`fields`）仍然被接受。
在批处理形状中，每个结果槽属于其排队的操作。回调按入队顺序运行，随后是带有完整数组的`exec`回调；返回的Promise解析为该相同数组。像`false`、`null`和`[]`这样的值会被保留而不是被当作假值过滤掉。回调中的异常会进入引擎诊断流，而后续回调仍会运行。提供者错误或结果数组长度不正确将拒绝整个批处理，且不会运行成功回调。操作队列在分发前被消耗，因此无法从先前失败的执行中重放回调。空的`exec()`会异步解析为`[]`，且不会发出几何请求。可移植的`select(...).exec()`简写仅在没有显式操作排队时才会排队一个边界矩形操作；这种便利性并非额外的官方API证据。

查询按树序读取最近的 `render.commit` 帧。支持 `#id`、`.class`、`tag`、简单组合（`view.card`）、逗号分隔列表、后代（`view .card`）、子元素（`view > text`）、相邻兄弟（`.a + .b`）以及一般兄弟（`.a ~ .b`）关系。还支持属性存在/相等选择器（`[disabled]`、`[data-state=ready]`，包括引号值）。`selectViewport()` 针对已提交的视口；`in({ scopeId })` 将查询限制在携带匹配 `data-sim-scope` 属性的渲染节点上。不支持的伪类选择器和格式错误的属性选择器将返回 `ERR_INVALID_REQUEST`。缺少已提交帧将返回 `ERR_RENDER`，因此 API 无法报告来自过时或伪造状态的几何信息。`all: false` 返回第一个匹配项（或 `null`），`all: true` 返回数组（或 `[]`）。这些空结果在 `exec` 批处理中保持其位置。

一个保留的 `NodesRef` 即使查询稍后创建了另一个引用，也会保持其原始选择。作用域属于查询，并在 `exec` 时被捕获用于所有排队操作。可移植的前端面板在提供的作用域描述符中接受非空的 `scopeId`/`__scopeId`/`id`；`in(null)` 会重置作用域。一个没有可用 id 的描述符将返回 `ERR_INVALID_REQUEST`，并永远不会退化到页面级查询。一个格式正确的作用域 id，其渲染节点缺失，将不返回任何节点匹配。此描述符约定目前尚不能证明 JavaScript `Component` 实例与 `data-sim-scope` 渲染子树之间的自动绑定。

`fields` 投影遵循公共 mpcore 合约：`rect`、`size`、`scrollOffset`、`id`、`dataset`、`mark`，以及任意组件的 `properties` 和请求的 `computedStyle` 名称作为扁平字段返回。`node` 和 `context` 在 JSON 桥接边界处返回可移植的描述符（`canvas` 节点保留其类型）。渲染节点保留 `data-*` 属性作为驼峰命名的 `dataset` 值，以及 `mark:*`/`mark-*` 属性作为驼峰命名的 mark 值；这些对象与指针事件中使用的对象相同。属性或样式列表格式错误将返回 `ERR_INVALID_REQUEST`。可移植的节点/上下文描述符不提供原生 Canvas/WebGL 对象身份或资源所有权。

SelectorQuery 仍为 `partial`。有效 manifest/host 支持控制
`wx.canIUse`。该封装层在 `exec` 时检查支持情况，包括空执行，且在成功回调或主机效果之前，若功能不可用则会抛出 `ERR_UNSUPPORTED_CAPABILITY` 错误。运行时在直接桥接和原生引擎效果边界处也进行相同能力的检查，因此手动发出的原生效果无法绕过协商。仅构造一个流畅对象并不能证明查询功能被支持。本地引擎/运行时的固定配置覆盖了这些不同的入口路径以及批处理/投影边界；它们并不能促进真正的 DevTools 或七主机证据。

`event.batch` 可能携带 `x`/`y`（或 `clientX`/`clientY`）且没有目标/路径。
会话对最后一次提交的帧进行一次命中检测，填充目标路径和数据集，然后以批次方式运行捕获/目标/冒泡分发。没有提交帧的指针事件将失败并返回 `ERR_RENDER`。页面处理器接收 `stopPropagation`、`stopImmediatePropagation`、`preventDefault` 和 `cancelBubble`；传播控制在批处理钩子结果中体现，且返回的分发列表在消耗它的处理器处被截断。
相同的命中检测还将 WXML 的 `mark:*`/`mark-*` 属性投影到 `event.mark` 中。标记按根节点到目标的顺序继承，更近的标记会覆盖相同键的值，符合公共事件标记契约；合并后的对象在捕获、目标和冒泡阶段保持稳定。

导航 URL 在相同边界进行归一化：`/pages/detail?id=7`
将 `pages/detail` 作为路由存储，并将字符串查询值传递给 `onLoad`；
百分比编码和 `+` 会被解码，显式 `query` 键会覆盖 URL 键，
且声明的 manifest 会在修改页面栈之前拒绝未知路由、`navigateTo`/`redirectTo` 的标签目标，或非标签的 `switchTab` 目标。
在页面钩子运行之前，也会拒绝空 URL 和仅包含空格的 URL。

QuickJS 和 V8 导航方法现在使用待处理的 `api.call` 请求，不会在导航效果刚入队时就报告成功。共享运行时操作校验能力、截止时间、取消状态与目标，提交页面状态并同步 `getCurrentPages()`，随后依次调用 `success`、`complete`，再兑现 Promise。失败时调用 `fail`、`complete` 并拒绝该请求；已处理失败不会丢弃同批后续请求，也不会额外触发全局错误。公开结果的 `errMsg` 使用 `navigateTo:ok` / `navigateTo:fail ...`；结构化失败保留 `ERR_*` 错误码和 `wx.*` API 名称。回调异常单独报告，不能跳过 `complete` 或 Promise 结算。

效果延续会持续耗尽，每个耗尽限制为每轮1024批，以及继承自主机的截止时间。达到任一限制后，会在消耗的追踪之后显式发出`ERR_TIMEOUT`事件。已完成的工作仍保持提交状态；排队的延续等待下一次主机轮次。这并不会标记所有承诺完成，也不会导致异常清理消耗另一个预算。`RequestTask.abort()`和桥接取消会更新相同的会话令牌注册表，并通知提供者，包括在导航请求同一轮次中排队的取消效果。这些是本地双引擎合规性结果；导航仍保持`partial`状态，直到获得官方和主机证据。

`wx.setNavigationBarTitle` 在修改当前 `PageEntry` 之前跨越了类型提供者边界。标题会被持久化到该页面实例中，因此会包含在页面栈响应中，当缓存的标签被激活时会恢复，且在执行 `redirectTo`、`reLaunch` 或 `onUnload` 后会被丢弃。缺少当前页面、非字符串标题以及提供者超时/取消失败的情况会返回结构化错误，而不会修改页面状态；空字符串是有效的标题覆盖。QuickJS 和 V8 的代理会在其批量主机效果中发出相同的克隆导航选项。

<a id="intersection-and-media-query-observers"></a>
## 相交与媒体查询观察器

`wx.createIntersectionObserver` 和 `wx.createMediaQueryObserver` 在 QuickJS 和 V8 中使用持久化会话所有者订阅。页面和组件实例也暴露了 `this.createIntersectionObserver(options)` 和 `this.createMediaQueryObserver()`。交集 API 接受仅选项的重载和 `createIntersectionObserver(component, options)` 重载。每个观察器和观察行为都有可序列化的身份；回调保留在隔离环境中，注册、断开连接和测量通知以批处理方式跨桥传递。注册确认不是测量，也不会触发观察回调。测量在成功执行 `render.commit` 或实际的宿主视口调整后产生。在空闲帧之后注册，会将其初始观察安排在下一个宿主定时器轮询时进行，因此不需要新的 `setData` 或重绘。由 ready/resize 事件钩子创建的订阅在该边界被测量之前已进入注册表。

交集选择器根据已提交的帧和拥有页面/组件作用域进行解析。显式组件参数或 `this.create*Observer` 使用组件选择器作用域。隐式 `wx` 工厂保留其生命周期所有者以进行清理，并使用页面选择器。结果包括 `id`、`dataset`、`intersectionRatio`、`boundingClientRect`、`intersectionRect`、`relativeRect` 和 `time`。几何信息使用四个变换节点角点的世界空间对齐边界，包括继承的变换原点。`display: none` 会被继承；零不透明度不会移除布局几何。默认的非原生模式直接将目标与配置的参考区域相交，允许多个 `relativeTo`/`relativeToViewport` 区域，其相交形成根区域。`nativeMode` 使用祖先参考并沿祖先路径裁剪。边距会扩展或收缩相应的参考区域。阈值和 `initialRatio` 控制通知，因此未改变的已提交测量值不会反复触发回调。`observeAll` 选择多个作用域目标。

媒体查询使用 `width`、`minWidth`、`maxWidth`、`height`、`minHeight`、`maxHeight` 和 `orientation`（`portrait` 或 `landscape`）。它们评估主机的逻辑视口，在主机未提供尺寸时使用第一个已提交帧的视口。初始交付发生在已提交的测量边界时，然后通知报告 `matches` 转换；如果重复调整尺寸且匹配结果相同，则不再通知。当前辅助基线将相等的宽度和高度视为 `landscape`；这是媒体查询的几何特性，而不是物理设备方向 API。

`disconnect()` 释放观察者，并且页面卸载/组件解绑会释放其拥有的订阅。本地断开也会在取消后阻止排队的回调被传递。无效的描述符、阈值和选择器返回 `ERR_INVALID_REQUEST`；未协商的能力返回 `ERR_UNSUPPORTED_CAPABILITY`，并使 `wx.canIUse` 返回 `false`。独立的 `SandboxProvider` 不会宣传或提供任一观察者 API：它会明确返回不支持的错误，而不是伪造零几何或一次性匹配。会话句柄在提供者分发前进行观察。

两个 API 仍为 `partial`。生命周期和观察器回调建立了拥有上下文；任意的 Promise 链不会传播隐式的组件所有权。隐藏页面的观察时机和动态目标身份仍需要官方的 oracle 覆盖。滚动偏移目前是元数据，并不会移动渲染的子树；实际的滚动观察尚未实现。世界 AABB 无法证明像素可见性、遮挡或精确的旋转区域裁剪。缓存的公共类型声明描述了初始交付作为变化比率达到阈值的情况，而无头辅助程序忽略交集选项，Web 辅助程序使用浏览器观察器规则。确切的阈值相等/跨越、初始零面积行为以及正方形视口方向因此仍需要固定的 DevTools/SDK oracle。本地几何和订阅测试无法证明官方 DevTools、主机 GPU、模拟器或物理设备的一致性；这些观察器门控尚未为本次变更运行。

## Canvas 2D

QuickJS/V8 提供 `wx.createCanvasContext` 的批量 2D 命令上下文。属性设置和
绘制方法只追加到本地命令队列；`draw(reserve?, callback?)` 才发出一个
`wx.canvas.draw` bridge 请求，携带 `canvasId`、`reserve` 和完整命令数组。
Sandbox provider 会校验命令操作名和参数形状；runtime 随后将同一批命令转换
为 `container-render-skia::CanvasFrame`，在一个 renderer 边界内重放并保存按
`canvasId` 寻址的 RGBA8 snapshot。`reserve:false` 替换该 canvas 的命令历史，
`reserve:true` 追加历史，宿主可以通过 `canvas_snapshot_json(canvasId)` 一次性
取回完整像素缓冲。软件路径支持颜色、矩形、路径、变换、文本、线帽/线连接样式
（`setLineCap`、`setLineJoin`、`setMiterLimit`）、虚线样式
（`setLineDash(pattern, offset?)`）和状态栈；奇数长度 pattern 按 Canvas 2D
规则重复一次，负数或非有限值在 provider 边界返回 `ERR_INVALID_REQUEST`，渲染器
按 dash/间隔交替生成笔画。已知但还没有资源生命周期契约的 `drawImage`、阴影和
文本对齐命令会返回明确的 `ERR_RENDER`，不会静默丢弃绘制。未声明 capability 时创建 context 立即返回
`ERR_UNSUPPORTED_CAPABILITY`，不会伪造绘制成功。

<a id="animation"></a>
## 动画

`wx.createAnimation` 在 QuickJS 和 V8 中提供与 `weapp-vite` WebAnimation polyfill
一致的本地链式对象。属性变换（包括 `opacity`、尺寸、平移、旋转、缩放、矩阵、
颜色和 skew）只追加到当前步骤；`step(options)` 将操作批量封装为
`{ animates, option }`。每个导出的 step 都会物化四个微信默认选项：
`delay: 0`、`duration: 400`、`timingFunction: "linear"` 和
`transformOrigin: "50% 50% 0"`，调用者传入的同名值会覆盖对应默认值；`export()` 返回
`{ actions: [...] }` 并清空已导出的队列。`scale(x)` 和 `translate(x)` 分别按
微信行为补齐为 `(x, x)` 和 `(x, 0)`。

该 API 的 JS 语义不产生逐操作 bridge 请求；导出的 JSON 可通过 `setData` 进入
View/Renderer。能力仍标记为 `partial`，因为各宿主还需要提供逐帧时钟、CSS/Skia
变换插值和动画取消/资源释放证据。若协商结果为 `unsupported`，创建对象会同步
抛出 `ERR_UNSUPPORTED_CAPABILITY`，并且 `wx.canIUse('wx.createAnimation')`
返回 `false`，不会返回一个静默空对象。

<a id="wxss-and-inline-style-rendering"></a>
## WXSS 和内联样式渲染

Inline `style` 绑定和 WXSS 声明进入相同的 IR 优先级级联。
重要性在内联/选择器特异性及源顺序之前进行比较；
因此，作者的 `!important` 声明会胜过普通内联样式，而重要的内联声明会胜过重要的样式表规则。
支持的简写形式在比较前会贡献其完整形式，保留声明顺序，而不是在收集属性映射后应用简写优先级。内联解析会保留引号字符串/函数内的分隔符，并单独忽略错误的声明。

最终的声明映射驱动了计算样式投影、布局、背景、前景、不透明度和z-index。因此，动态宽度会同时改变绘制区域和输入命中测试树。支持的颜色继承遵循合成渲染树；背景、不透明度和几何属性不会被继承。兄弟元素的绘制和命中测试共享一个稳定的z-index顺序，且有效的负边距简写保留其带符号的布局偏移。`computedStyle` 仍会暴露一些获胜的声明字符串；完整的计算值归一化和无效简写过滤尚未实现。这解决了之前的问题，即查询可以报告内联值，而布局和像素仍使用样式表。

`visibility` 在投影之后确定，并通过组合树继承。隐藏的节点保留几何信息，而可见的后代节点保持祖先的变换/裁剪/不透明度以及普通冒泡行为。无效声明在级联之前被丢弃；有效的但不受支持的声明拒绝场景准备，并保留被接受的帧。有关 visibility 的有界语法、wire 兼容性以及 CPU 渲染验证，请参见 [visibility](visibility.md)。

一个带有 manifest 支持的 `render.commit`，如果没有显式指定 `data`，将读取当前页面所接受的 AppService 数据。显式指定的数据（包括 `{}`）仍为覆盖操作；渲染不会替换页面存储的数据。导航会选择当前页面的快照，因此返回到被覆盖的页面时，无法渲染后续页面的数据。这些是针对已承认的样式/表达子集的本地约定，不能作为完整 CSS/WXSS 或官方主机一致性证据。

显式 `overflow`、`overflow-x` 和 `overflow-y` 现在也限制了后代绘制以及命中测试。软件光栅化、原生 Skia 以及 Web CanvasKit 演示器共享已确认的轴规则：`hidden`/`auto`/`scroll` 裁剪，`clip` 可以在 `visible` 之外限制一个轴，而 `visible` 会计算为一个裁剪轴，同时伴随一个滚动轴。双轴裁剪使用祖先在变换坐标空间中的归一化角半径；单轴裁剪保持另一轴开放。嵌套裁剪相互交集，不会泄露到后续的兄弟节点。节点在应用其后代裁剪之前会先绘制自身的背景。裁剪使用内边框边缘（内边距框）；节点本身仍会接收其外层圆角边框的输入。[边框契约](wxss-borders.md) 定义了共享的尺寸和几何属性。完整的 CSS overflow 一致性仍需要 overflow-clip-margin、固定位置逃逸规则、实际滚动以及官方 DevTools 视觉对比仍不完整。`overflow-clipping` 运行时固定装置会向 `scripts/overflow-clipping-browser-smoke.mjs` 发出被接受的帧以供回放；浏览器 WebGL 读回操作并不能建立物理 GPU/设备或性能接受标准。

<a id="wxml-component-slots"></a>
## WXML 组件插槽

`container-ir::project_wxml_slots` 在宿主构建渲染树之前，为自定义组件模板应用可观察的投影规则。带 `slot="name"` 的直接 light 子节点分组到匹配的命名 `<slot
name="name">` 出口；无标记的子节点使用默认出口。没有分配子节点的出口递归渲染其 fallback 子树，空出口被移除。该辅助函数克隆组件模板和投影子节点，因此每个实例均可复用同一份已解析模板，不会在页面间泄漏 slot 状态。

`project_wxml_slots_with_options(..., false)` 表示一个不启用 `multipleSlots` 的组件：所有轻量级子节点流入默认插槽，且 `slot` 标记被视为组合元数据而非可渲染属性。动态插槽名称在调用者评估组件实例数据之前保持为字面值；这使得 IR 辅助函数具有确定性，并避免了每个节点的 JavaScript 桥接调用。

`evaluate_wxml_with_templates` 也支持 WXML 中的 `<import src="..." />` 声明。导入的文件会将其命名的 `<template name="...">` 定义添加到调用者的查找作用域中，而导入声明本身将从渲染树中移除。导入路径支持包相对名称以及清单中的 `template:<path>` 数据块 ID。目标缺失和递归导入循环将导致确定性的 `MarkupError::InvalidSyntax` 错误，即使在数据依赖分支中不会调用导入的模板；这可以防止错误的包图结构变成特定主机的行为。

模板查找是包作用域而非全局映射查找：在清单中存在但未在当前 WXML 文件中声明且未通过 `<import>` 达到的模板 blob 将不可见，并会产生结构化的 `WXML template target not found` 错误。`<include>` 被视为文本扩展，因此被包含文件中的命名声明将变得可见；递归的包含图将在数据评估前被拒绝。这防止了无关的清单模板进入可移植求值器的查找范围；官方的差分验证仍待处理。

模板扩展和绑定评估共享相同的數據遍歷。
每个 `wx:for` 的出现都会在评估同一节点的条件或 `<template is="..." data="...">` 之前安装其项/索引别名。嵌套循环和 `<include>` 保留当前的别名，相对路径从声明包含的文件继续。一个非活动分支不会评估其动态模板名或数据。在数据评估之前，导入/包含图仍然会单独进行验证，因此一个无效的声明包图无法隐藏在非活动分支之后。评估的模板文本和属性作为值插入；像 `{{secret}}` 这样的数据字符串在父页面绑定中将不再被解析。源AST在调用之间保持可重用。

便携式绑定表达式使用 Rust 词法分析器和 Pratt 解析器在序列化数据快照上运行。纯子集包括字面量、点运算/计算成员访问、一元 `!`/`+`/`-`、算术运算、相等/关系比较、逻辑运算、嵌套条件以及支持展开形式的数组/对象字面量。解析在求值之前会验证整个表达式；短路选择在解析出的纯子表达式中。缺失值、`undefined`、`null`、类型转换和数组/对象身份具有明确的本地语义，而不是被委托给字符串分割或宿主 `eval`。这是一个有边界的表达式子集，而不是完整的 JavaScript 或 WXML/WXS 实现：调用会被拒绝并抛出 `MarkupError::InvalidSyntax`，且 WXS 模块、赋值和副作用不会执行。没有回退机制，不会静默地将不支持的绑定发送给 QuickJS/V8，也没有每个节点的 JS/Rust 交互。这些本地约定在差分证据覆盖所承认的子集和每个宿主之前保持为 `partial`。

在该子集内，WXML 绑定表达式保留了 JavaScript 中逻辑运算符的值选择行为。`a || b` 在其左值为真时返回 `a`，否则返回 `b`；`a && b` 在 `a` 为真值时返回 `b`，否则返回 `a`。这在插值（如 `{{title || 'Untitled'}}`）中尤为重要，必须渲染所选字符串而不是布尔值。可移植的求值器会保持该结果在序列化数据快照中的确定性；它不会运行页面方法或 WXS 函数来获取绑定值。

成员表达式还支持计算括号访问。例如，`{{items[index].name}}`、`{{lookup[key]}}` 以及类似 `{{matrix[row][column]}}` 的嵌套形式会在当前 WXML 作用域中求值每个括号表达式，带引号和数值键的保留 JavaScript 属性键转换行为。空或未终止的括号将被报告为确定性的 `MarkupError::InvalidSyntax` 错误，而不是被当作字面属性名处理。这使得动态列表/表格查找与 QuickJS/V8 面板保持一致，同时保留了可移植求值器的与主机无关的行为。

同一个求值器处理括号内的算术/比较运算和嵌套条件表达式，例如`{{ready ? (count >= 2 ? 'many' : 'few') : 'off'}}`。在查找之前会验证分隔符，因此不匹配的括号、引号或成员索引会产生结构化语法错误，而不是缺失值的渲染。`wx:key`在属性插值期间仍保持为指令值，这保留了原始重复项的特殊`*this`键形式。

WXSS 解析在渲染器提供根节点到父节点的祖先关系时，支持后代和子元素选择器链（`.card .title` 和 `.card > text`）。选择器链匹配后，会应用现有的特异性/重要性/源顺序优先级机制。渲染器在构建每个 WXML 节点时，现在会传递该祖先关系，因此计算样式和布局使用与选择器查询和命中测试消费者观察到的相同选择器结果。

相同的渲染树上下文支持结构伪类：`:first-child`、`:last-child`、`:only-child`、`:nth-child(...)`（`odd`/`even` 和 `an+b` 形式），以及 `:not(<simple-selector>)`。该渲染器会计算元素兄弟节点，并且会省略这些位置的格式化文本和注释。仅用于身份匹配的 `matches_wxss_selector` 辅助函数在未提供兄弟上下文时，故意不匹配这些伪类；渲染器路径使用带有从一基的子节点位置元数据的 `resolve_wxss_style_for_node`，以便计算样式和布局获得相同的结果。动态状态伪类（如 `:hover`）仍不支持，且不会被静默地视为匹配。

`wx:for` 扩展会在每个重复元素上记录一个可选的 `key`。例如 `wx:key="id"` 会从对象项中读取该属性；明确指定别名的表达式则使用当前循环作用域。原始项支持 `wx:key="*this"`。源节点中省略了仅用于评估的身份元数据，以保留现有 v1 的标准清单字节。

当评估的AST进入渲染器时，`RenderNode.key` 保留了该身份。生成的节点标识符包含循环的源位置、祖先循环身份以及一个编码后的键段，因此不同源循环可以重用键而不会发生冲突，分隔符字符也不会形成额外的路径段。当项目在其源循环中重新排序时，唯一键保持稳定；未标记键的节点使用位置身份。会话拥有的管理组件使用这些身份进行本地协调，并拒绝重复的键值出现。CanvasKit、原生宿主和官方运行时的一致性仍需要单独的证据。

manifest `render.commit` 路径现在为本地静态 `usingComponents` 关系应用此投影。例如页面模板 `template:pages/index/index.wxml` 会查找其所有者配置（`pages/index/index.json`），将每个别名解析为内容寻址的 `template:<target>.wxml`，评估该组件模板，并在布局前将自定义标签替换为投影的组件树。`multipleSlots` 从组件 JSON 或静态词法解析的 `Component({ options: { multipleSlots } })` 注册中继承；省略的选项使用微信默认值（`false`）。缺失的插件/npm 目标在显式主机/提供者边界下仍保持未解析状态，且不会报告组件渲染一致性问题。

配备原生 QuickJS/V8 提供商时，会话会自动创建、协调和销毁管理组件实例，在批处理图前沿中进行。每个实例拥有独立的数据、属性默认值、观察器和生命周期钩子。纯 Mustache 属性在可选的 IR 绑定值中保留 JSON 值；声明的属性绑定会规范化短横线命名，并仅更新变更的父级输入。组件 setData 会失效帧，内部事件处理器将在相应实例上运行。在 app.init 中提供经过验证的 blob 可在页面 onLoad 之前进行附加；ready 会在首次渲染提交后执行。较旧的显式组件工厂仍可供主机适配器使用。

投影的槽内容独立承载声明数据、事件所有权以及usingComponents查找信息，与它的视觉父组件分离。组件作用域的查询选择器和内部命中测试身份使重复的公共ID得以区分。带键的更新保留存活的实例；被移除的实例将被解离，其延迟补丁将被丢弃。安全的呈现重载会保留该图谱，而结构化组件编辑则会启动一个隔离的替换会话。

组件页面生命周期.show/hide 通过一个专用引擎批处理跟随会话页面可见性。同名的普通方法不能遮蔽它们；抛出钩子在每次转换中仅报告一次，不会跳过兄弟元素。缓存的标签页和被遮挡的页面仍保持隐藏，且重新启动会释放缓存以及活动组件。窗口大小调整不会创建组件大小调整生命周期。本地合约不能证明每个官方钩子的排序。页面/组件的 selectComponent 和 selectAllComponents 使用版本化的、批处理的声明树索引，包括普通节点。ID/类组合选择器、子选择器、后代选择器和并集选择器返回同页面中实时的树序匹配项；首次匹配的原生节点解析为 null，而不是跳转到后续的自定义组件。投影内容保留声明祖先关系。重排声明的命名槽投影仍遵循本地渲染遍历顺序；其选择顺序的一致性仍未知。嵌套的 selectOwnerComponent 使用声明所有者而不是物理槽接收器。此直接页面子节点所有者的当前空结果是一个辅助兼容性候选：固定SDK证据仍未知，而较新的公共glass-easel引用可以返回页面所有者。

跨组件 >>>，标签/属性模式和具有自定义导出函数的目标明确返回 ERR_UNSUPPORTED_CAPABILITY。导出目标从不静默暴露其内部实例。所有五种选择方法都有部分能力条目，并尊重协商的不支持能力。属性观察者可以在不更改任何组件记录的情况下修改原生选择元数据。接受的前沿在附加钩子之前重新发布该元数据，包括向仅原生树的过渡。如果新的渲染前沿失败，仅发布批次将恢复已接受的引用树，而不会重复观察者或生命周期；它不会回滚任意的用户 JS 效果。销毁页面将清除其整个选择索引，包括在回滚期间首次发布的原生索引。在先前前沿中准备的且被附加钩子隐藏的条目将在最终树被接受前被解离。累加能力清单和清单金本保留 v1 模式；其能力名称语法现在也接受一个页面/组件方法标识符。Rust 验证、JSON 模式和打包器强制执行相同的命名空间边界。较旧的验证器可以明确拒绝这些新键。

见 [公共资料和被阻塞的原生探针](archived-evidence.md)。
该探针持有机器租赁并使用了一个自有原生项目；已保留一个正在运行的DevTools主机，但尝试收集到的运行时结果为空。关系、完整的选择/导出语义、插件/npm组件解析、完整属性规则、样式隔离以及完整的主机语义仍不完整。组件/插槽的覆盖范围仍为部分；本地测试未推广任何官方符合性案例或主机门禁。

<a id="component-custom-events"></a>
## 组件自定义事件

`Component.triggerEvent` 是一个部分功能受限的 API，作用于会话所拥有的组件实例。会话会将一批事件图发布到选定的 QuickJS/V8 隔离空间。`triggerEvent(name, detail, options)` 会解析监听器并调用同一 JavaScript 执行周期内监听器声明的所有者；由监听器发出的自定义事件将使用相同的边界。它不会为每个祖先发送一次 Rust/JS 请求，也不会在本地监听器之间序列化 `detail`。本地合约保留了所提供 JavaScript detail 对象的标识。该事件图在生命周期和输入回调之前进行准备，因此事件分发不依赖于帧已绘制完成。

`name` 必须是非空字符串。省略的选项使用空对象；显式为 null、数组和非对象的选项是无效的。提供的 `bubbles`、`composed` 和 `capturePhase` 值必须是布尔值；未知的选项键将被忽略。无效输入和已过期/已销毁的接收器返回 `ERR_INVALID_REQUEST`。旧版显式组件工厂缺少管理作用域，并使用相同的拒绝而不是模拟传递。没有发布事件图/页面的活动作用域返回 `ERR_UNSUPPORTED_CAPABILITY`，未协商的 `Component.triggerEvent` 能力同样如此。

该隔离实例直接保留`detail`，包括未定义、函数和循环对象；事件效果包含路由元数据和计数，而不是将该对象序列化到桥接跟踪中。本地生命周期合约允许在创建/附加时以及在脱离钩子期间（只要发生仍处于活动状态）进行发射；脱离完成后，保存的引用将拒绝新的发射。这些规则描述了允许的本地子集，而不是对参数验证或生命周期分发时机的正式观察。

`triggerEvent` 返回 undefined。监听器异常会进入现有的引擎诊断流，而后续监听器仍会运行，除非传播已被捕获。嵌套发射具有本地 128 级递归限制，超出该限制时会抛出 `ERR_ENGINE`；此资源限制并非微信兼容性声明。会话只有在验证通过后才会发布完整的页面事件图，在发布失败时会保留其之前的事件图。

`bubbles`、`composed` 和 `capturePhase` 默认为 false。默认路径会调用直接组件监听器。显式捕获与冒泡无关；非合成传播在包含组件边界处停止，而合成传播可能继续通过外层树。`catch` 和 `capture-catch` 会延迟传播停止。图的拥有权会将组件宿主监听器保留在其声明的所有者上，并将投影槽处理器保留在其声明侧。这些传播、细节身份和同轮规则是本地符合性协议，而非新的官方运行时观察结果。

监听器拼写遵循已保存的 DevTools `2.02.2608080` / 基础库 `3.17.3` 别名和命名事件观察结果：

| 事件名称 | 无绑定 | 列绑定 | 同一个节点上都绑定 |
| --- | --- | --- | --- |
| `probe` / 原生 `tap` | `bindprobe` / `bindtap` | `bind:probe` / `bind:tap` | 无论属性顺序如何，裸绑定均优先 |
| `probe_under` | `bindprobe_under` | `bind:probe_under` | 优先级绑定胜出 |
| `probe-hyphen` | 无结合 | `bind:probe-hyphen` | 仅冒号结合生效 |

可重用的预言机是
[`lifecycle-compare.json`](archived-evidence.md)：
其别名案例记录了13个 `alias:*` 检查点，包含18个计数器，其命名事件案例记录了13个 `named:*` 检查点，包含16个计数器。两种原生和WeVu SFC组件发射器均被覆盖；别名案例还覆盖了原生视图点击。保存的 `acceptance.evidence` 条目包含观察到的 `devtools-page-frame` 文本，而不仅仅是预期的检查点定义。完整的原始套件共有50个检查点，但它未观察到自定义事件详细身份、同轮顺序、选项默认值、组合重定向或生命周期时间发射。

上游 `e2e/ide/issue-1126-1128.test.ts` 提供了私有/捕获-only/本地/组合事件以及catch行为的候选断言。其索引状态仍为 `unknown`，且没有保存的官方运行确立了这些事件边界规则。本地双引擎测试必须保持这一区别。该API不完成关系、WXS、插件边界、所有组件事件语义或任何七主机/官方符合性门禁。

<a id="host-provider-apis"></a>
## 宿主 provider API

该会话拥有一个可替换的 `HostApiProvider`。默认的 `SandboxProvider` 从不触及机器的网络或文件系统；它提供确定性的系统信息、请求响应、内存中的文件、剪贴板状态以及明确的权限结果。原生主机通过 `Session::set_provider` 使用已审核的提供者替换它，同时保持相同的批量请求和错误形状。

提供者边界涵盖 `wx.getSystemInfo*`、`wx.request`/`uploadFile`/`downloadFile`、文件系统操作（包括 `wx.saveFile`、`wx.getFileInfo`、`wx.getSavedFileInfo`、`wx.getSavedFileList` 和 `getFileSystemManager().saveFile`）、剪贴板和网络信息、振动/保持屏幕开启、媒体/位置、登录/个人资料/支付和分享调用。确定性网络沙箱按 URL 接受预设响应。`wx.request` 需要URL，并且其`method`与无头运行时完全一致（省略或为空表示`GET`，否则去除空格并转为大写）；其响应保留公共的`statusCode`、`header`、`cookies`、`data`和`errMsg`字段。返回的请求/上传/下载对象保持 thenable 特性，供Promise消费者使用，并暴露`abort()`、`onHeadersReceived()`和`offHeadersReceived()`；在提供者分发前调用 abort会发出取消令牌并抑制后续的成功回调，而`fail`/`complete`将接收稳定的`ERR_CANCELLED`封装体。当响应包含`header`时，头信息监听器在`success`之前运行一次。包含`data`的种子对象被视为完整响应封装体，而纯种子值则作为响应`data`保留。`wx.uploadFile` 还需要一个存在于提供者内存文件存储中的`filePath`和一个非空的表单`name`；其成功结果被限制为公共的 `{ data: string, statusCode, errMsg }` 形式（表单名称、路径、字节数、请求头和cookies保持在提供者诊断中）。`wx.downloadFile` 将响应字节写入请求的`filePath`，或在未指定时写入确定性的内容寻址临时路径，并仅返回 `{ tempFilePath, statusCode, errMsg }`。

`wx.getMenuButtonBoundingClientRect()` 是一个同步系统 API。提供者返回 `left`、`right`、`top`、`bottom`、`width` 和 `height`，单位为逻辑 CSS 像素。原生宿主可通过 `HostMetadata.menuButtonRect` 注入其安全区域/菜单几何信息；确定性沙箱在没有宿主几何信息时返回显式零矩形，且从不伪造平台特定值。

`wx.getAppAuthorizeSetting()` 是一个同步权限快照。它将提供方的显式权限状态映射到文档中关于相机、位置、麦克风、通知和相册访问的 `authorized`、`denied` 和 `not determined` 字符串。它不会弹出提示，且未经协商的权限将触发 `ERR_UNSUPPORTED_CAPABILITY`。

`wx.onNetworkStatusChange()` 是一个主机驱动的观察器，而不是轮询回退。原生/网页适配器会调用 `Session::notify_network_status_change`，并传入带类型化的 `NetworkType` 枚举；`wx.getNetworkType()` 所使用的提供者快照会先被更新，然后所有已注册的回调函数将在同一引擎批次中接收到一个克隆的 `{ networkType, isConnected }` 负载。`wx.offNetworkStatusChange` 在未提供函数时会移除一个回调或清空监听器列表。沙箱从不采样机器网络，也不会伪造网络状态转换。

`wx.getAccountInfoSync()` 也在模块评估之前被安装。可移植提供程序实现了完整的同步合约，并返回一个稳定的 `{ miniProgram: { appId, envVersion, version }, plugin }` 快照；沙箱默认使用空的 app ID、`develop` 和空版本，而原生主机可通过其提供程序注入包身份。`envVersion` 在提供程序边界上会验证文档中规定的 `develop`、`trial` 和 `release` 值。无效的主机快照将返回 `ERR_INVALID_REQUEST`，而不是暴露一个未识别的值作为成功账户结果；沙箱在小程序上下文中使用空的 `plugin` 对象；每次同步的前端调用都会接收一个克隆的快照，因此 JavaScript 的修改不会影响提供程序状态。此可移植的完整状态不会促进七个主机覆盖条目，这些条目在每个主机提供身份注入证据之前将保持部分状态。

`wx.getExtConfigSync()` 与其它同步提供者的快照一起在模块评估前安装。`wx.getExtConfig()` 使用常规异步提供者分发和回调/承诺封装。两个 API 读取相同的提供者拥有的 `{ extConfig: object }` 快照；确定性沙箱默认为空的 `extConfig` 对象，并提供 `with_ext_config(...)` 用于合规性测试 fixture。异步响应包含 `errMsg: "getExtConfig:ok"`。

`wx.connectSocket` 使用相同的提供者边界。沙箱会验证 `ws://` 或 `wss://` URL，分配一个确定性的 `socket-N` ID，并使用 `readyState = 1` 解析任务的 `onOpen` 回调。`SocketTask.send` 会记录有效负载并返回 `sendSocketMessage:ok`；`SocketTask.close` 会验证 1000..4999 之间的关闭码，转为 `readyState = 3`，并分发关闭码/原因。不会伪造任何入站消息或主机网络：在该能力被提升到 `partial` 之前，原生提供者必须提供传输、消息传递、权限和终止的证据。

`getFileSystemManager().access` 对 `readFile` 和 `uploadFile` 所使用的同一内存文件命名空间进行存在性检查。存在文件返回 `access:ok`；缺失的路径返回结构化的无效请求错误 `access:fail no such file or directory, access '<path>'`，而不是伪造的成功。

同步管理器方法（`readFileSync`、`writeFileSync`、`accessSync`、`unlinkSync` 和 `readdirSync`）使用在模块评估之前安装的基于权限范围的文件快照。文本和 base64 读取保留在隔离环境中；二进制读取在引擎提供 `Uint8Array` 时会暴露一个 `ArrayBuffer`。写入和删除操作会立即更新本地快照，并向主机提供方发出一个 `api.sync` 变化效果。如果提供方无法提供快照，则会报告稳定的 `ERR_UNSUPPORTED_CAPABILITY` 错误，而不是静默地使用过时数据。

`getFileSystemManager().readdir({ dirPath })` 跨越提供者边界并在一次批次中返回 `{ files, errMsg }`。沙箱从其归一化的内存命名空间中直接推导出子项名称，包含目录前缀，按 UTF-8 顺序排序，并为已存在或为空的目录返回空列表。`readdirSync(dirPath)` 将相同的投影直接应用于同步快照，因此 QuickJS 和 V8 观察到相同的结果。

敏感操作需要在提供方显式授权；授权被拒绝将产生 `ERR_PERMISSION_DENIED`。每个提供方操作在分发前都会检查绝对桥接超时期限和取消令牌，即使是对看起来同步的系统、剪贴板、观察者和认证调用，也会一致地产生 `ERR_TIMEOUT` 和 `ERR_CANCELLED`。在清单中存在但没有提供方实现的 API 将产生 `ERR_UNSUPPORTED_CAPABILITY`，而不是返回伪造的 `result: null`。

`wx.authorize` 和 `wx.openSetting` 使用相同的提供者权限状态。沙箱会验证文档中列出的权限名称，仅对明确授予的权限返回 `authorize:ok`，并从 `openSetting` 中暴露一个稳定的 `authSetting` 映射；它从不会提示或静默授予权限。

`wx.getLocation` 接受文档中规定的 `type` 值（`wgs84` 和 `gcj02`）以及布尔型的 `altitude` 选项。确定性沙箱会返回包含 `latitude`、`longitude`、`speed`、`accuracy`、`altitude`、`verticalAccuracy`、`horizontalAccuracy` 和 `errMsg` 字段的零值坐标。它永远不会暴露机器的地理位置；无效选项、缺少权限、过期的截止时间或存在活动的取消令牌将产生相应的结构化提供程序错误。

`wx.chooseMedia` 和 `wx.chooseImage` 在访问主机资源前会验证选择项：`count` 必须是 1 到 9 之间的整数，选项数组仅接受其文档中规定的值（`image`/`video`/`mix`，`album`/`camera`，或 `original`/`compressed`），且媒体相机必须为 `front` 或 `back`。在授予 `photos/camera` 权限时，沙箱会返回确定性的空 `tempFiles` 和 `tempFilePaths`；原生提供者在替换该选择时会保持相同的结果和错误形态。

`wx.createInnerAudioContext` 返回一个具有状态的上下文对象。属性写入（`src`、`startTime`、`autoplay`、`loop`、`volume`、`playbackRate` 和 `obeyMuteSwitch`）作为带类型 `set` 命令发送；`play`、`pause`、`stop`、`seek` 和 `destroy` 通过 `wx.innerAudioContext` 提供者操作批量处理。沙箱会验证源地址、数值范围和已销毁上下文的使用，然后报告结果的 `paused`/`currentTime` 状态和事件名称。它不声称解码或输出音频；原生提供者拥有解码器、焦点、路由和资源生命周期，并必须保持此结果/错误形态。

`wx.createVideoContext(videoId, component)` 返回一个组件作用域的命令对象。`play`、`pause`、`stop`、`seek`、`playbackRate`、`sendDanmu`、`requestFullScreen`、`exitFullScreen`、`showStatusBar` 和 `hideStatusBar` 通过 `wx.videoContext` 批量处理。沙箱会验证 ID、数值范围、弹幕文本/颜色以及全屏方向，然后记录确定性的传输和 UI 状态；它不进行视频解码或渲染。原生提供者拥有解码器、表面、方向和资源释放，同时保持相同的结果和错误形态。

`wx.createCameraContext()` 返回一个上下文，其 `takePhoto`、`startRecord`、`stopRecord` 以及 `onCameraFrame(...).start/stop` 命令会跨越 `wx.cameraContext` 提供者边界。提供者会验证质量、录制超时、上下文生命周期和相机权限。确定性沙箱中没有相机设备、解码器或帧源：在验证后会返回结构化的 `ERR_UNSUPPORTED_CAPABILITY` 错误，而原生提供者可能仅用真实路径/帧替换采集和资源释放。

<a id="module-and-page-lifecycle"></a>
## 模块与页面生命周期

原生 QuickJS/V8 会话在评估内容寻址的 CommonJS 模块之前，会安装 `App`、`Page`、`Component` 和 `getApp` 的全局注册。
主机提供一个经过验证的模块批次。在入口评估之前注册工厂，共享的 JS 注册表通过声明的依赖关系边解析模块本地的 `require`，而无需为每个依赖关系调用 FFI。
重复 require 保留导出身份；CommonJS 循环会看到部分初始化的导出。在应用执行之前，由所选引擎的 `JSON.parse` 验证 JSON 语法，包括其数字和 UTF-16 域。
JSON 模块保留自己的 `__proto__` 属性和负零，而不是使用 JavaScript 对象字面量求值。
评估失败将丢弃该模块的导出缓存，而完成的依赖项保留其导出缓存。App、page、component 和未引用的旧版批次根节点会立即求值；被声明为依赖的模块在通过 `require` 或显式 `module.call` 被触及时求值。ESM 子集使用相同的注册表，并按源声明顺序求值依赖项，包括重新导出。
它不实现live bindings、动态导入、导出星号或涉及 ESM 的循环；不支持的语法和 ESM 循环会明确失败。这不会添加完整的 Node 解析环境或对任意主机文件的访问。

独立的遗留 eager 加载器保留了其原子性嵌套注册合同。它无法在该事务内启动新的注册工厂：运行时会在修改工厂缓存或注册表之前，拒绝这种混合的首次求值，报错 `ERR_MODULE_LOAD`。读取已求值或正在求值的模块仍受支持。

当 manifest entry module 被加载时，`app.init` 会使用 `launchOptions` 调用一次 `App.onLaunch`。`page.push`/`page.replace` 会按顺序调用注册页面的 `onLoad`、`onShow` 和首次渲染的 `onReady`；`page.pop` 会调用 `onUnload`。替换操作首先卸载并注销旧页面，因此延迟事件或 `setData` 修补无法处理已销毁的注册。`reLaunch` 从栈顶到底部卸载现有页面栈，按照嵌套页面的所有权顺序进行。`switchTab` 从栈顶向下卸载非标签页，隐藏当前活动标签页根节点，并在会话缓存中保留每个标签页的页面 ID、查询参数和数据。返回到缓存的标签页会触发 `onShow`，而不会重新运行 `onLoad` 或创建新的页面实例。钩子返回值保留在响应包的 `hooks` 字段中，因此宿主无需为每个生命周期回调调用一次 FFI。仅使用协议构建的版本会报告空的钩子结果，并将执行交由选定的原生提供者处理。

每个新的页面实例都会克隆其注册的 `Page.data`，并在 `onLoad` 之前将该初始状态返回给 AppService。因此，即使页面没有生命周期钩子或 `setData` 调用，也会默认渲染。在 `page.push`/`page.replace` 中，可选对象 `data` 会浅层覆盖这些默认值一次；钩子将看到合并后的值，后续的 `setData` 会生效。现有实例永远不会被后续栈同步所覆盖。

组件注册也按声明顺序组成行为定义：
嵌套行为和组件的`data()`工厂在属性默认值安装前被合并，每个行为/组件的`created`、`attached`、`ready`、`moved`、`detached`或`error`钩子均按此顺序保留并调用一次。`pageLifetimes`（`show`、`hide`和`resize`）作为定义记录被合并。管理的实例通过专用的批处理边界自动获得显示/隐藏；仅在引擎边界测试resize数据的转发。这使得行为生命周期钩子不会被同名组件钩子静默替换，同时保留现有的批处理生命周期封装。

`getCurrentPages()` 作为全局页面栈封装接口存在。运行时在调用页面生命周期或事件钩之前，会更新当前活动注册索引以及每个页面的 `route`/`options` 查询快照。调用返回页面对象，按栈顺序排列，因此 `data`、`setData` 以及页面方法在 JavaScript 隔离中保持其身份。对同一路由的多次 `navigateTo` 调用将获得不同的页面实例（以及页面 ID）；一个实例的 `setData` 效果无法更新另一个共享相同 `Page` 定义的实例。被弹出或替换的注册项将从返回的栈中移除；由于没有可用的 JavaScript 页面提供者，协议引擎会报告空栈。

<a id="conformance-ids"></a>
## 兼容性 ID

| ID | 验证 |
| --- | --- |
| `storage-001` | set/get/remove/clear 在同一 session 内保持 JSON 值和隔离性 |
| `storage-002` | 空 key 被拒绝，未知 key 返回 `found: false` |
| `storage-003` | getStorageInfo* 返回稳定 key 列表、大小和容量 |
| `storage-004` | QuickJS/V8 与 mpcore 使用相同的 `[key,value]` UTF-8 大小计算，并保留 `getStorageInfo:ok` envelope |
| `storage-005` | QuickJS/V8、bridge 与 AppService 共享存储；模块顶层和异常前的写入保持，undefined/null 不混淆 |
| `storage-006` | 所有入口遵守 capability；禁用写入不产生 mutation，异步 fail/complete/Promise 错误一致 |
| `timer-001` | timeout 到期一次、携带 callbackId，poll 后移除 |
| `timer-002` | interval 按显式 host clock 重排 deadline |
| `timer-003` | clearTimeout/clearInterval 取消后不再产生 firing |
| `timer-004` | QuickJS/V8 通过同一 host poll 执行 callback/microtask，并提交 storage effects |
| `capability-001` | `wx.canIUse` 与 API dispatch 共享 effective capability |
| `api-unsupported-001` | 未声明或 unsupported API 返回 `ERR_UNSUPPORTED_CAPABILITY` |
| `selector-001` | `render.commit` 后按树顺序查询 id/class/tag 与 bounding geometry |
| `selector-002` | descendant/child/sibling 与属性 presence/equality 选择器命中已提交树；伪类、malformed 属性选择器和缺少 committed frame 分别返回 `ERR_INVALID_REQUEST`/`ERR_RENDER` |
| `selector-003` | `data-*` 投影为 dataset，坐标事件命中树并生成 path |
| `selector-004` | fields 的 rect/size/scrollOffset/id/dataset/mark/properties/computedStyle/node/context 投影及 malformed 参数错误 |
| `selector-005` | `selectViewport()` 与 `in({ scopeId })` 的 viewport/组件作用域查询 |
| `event-control-001` | QuickJS/V8 handler 的 stopPropagation/preventDefault/cancelBubble 控制捕获、目标和冒泡结果 |
| `event-mark-001` | `mark:*`/`mark-*` 继承、同名覆盖和 QuickJS/V8 `event.mark` 一致性 |
| `observer-intersection-001` | IntersectionObserver 配置、observe/disconnect 批量桥接及输入校验；独立 SandboxProvider 明确拒绝伪造测量 |
| `observer-intersection-002` | Session 持续订阅已提交树，覆盖 scope、world AABB、多参照区域、initialRatio、threshold transition、observeAll 和 native 祖先路径 |
| `observer-intersection-003` | disconnect、页面 unload 和组件 detach 释放订阅，已排队通知不泄露到旧实例 |
| `observer-media-001` | MediaQueryObserver descriptor 校验、page/component scope 与独立 provider 的 unsupported 边界 |
| `observer-media-002` | 首次 committed measurement 与真实 host resize 的 matches transition 去重、逻辑 viewport 和订阅释放 |
| `nav-003` | URL query 解码、显式 query 覆盖和 route/switchTab 校验 |
| `nav-004` | switchTab 逆序卸载非 tab 页面、隐藏 tab 根页面，并复用缓存的 page id 与 data |
| `nav-005` | `setNavigationBarTitle` 经过 typed provider 校验，并按页面实例保存标题；返回、替换和 tab 缓存恢复后保持正确标题 |
| `nav-006` | 双引擎导航在 runtime 提交后完成回调与 Promise；前置校验失败保留原页和同批后续请求，覆盖取消、deadline、回调异常及续传预算（`navigation_completion.rs` 与 engine 单测） |
| `canvas-001` | CanvasContext 命令在 draw 时单批跨 bridge，并由 provider 校验 |
| `canvas-002` | `setLineDash` 在 QuickJS/V8、provider 和软件 renderer 间保持 pattern、offset、奇数重复和错误语义一致 |
| `offscreen-001` | `wx.createOffscreenCanvas` 校验 2d 类型和尺寸，使用隔离 CanvasFrame 批量 draw；sandbox 可取得确定性 CPU RGBA snapshot，toDataURL/GPU 资源生命周期仍由宿主提供 |
| `animation-001` | QuickJS/V8 的动画链式操作、step 默认值、scale/translate 参数补齐和 export 后清空保持一致 |
| `api-unsupported-007` | 未协商 `wx.createAnimation` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `view-slot-001` | 默认/具名 slot 投影、fallback、嵌套 fallback 和 `multipleSlots` 关闭时的行为 |
| `style-cascade-001` | inline/WXSS importance、specificity、source order、受支持 shorthand 的 longhand 竞争和 declaration parser 边界 |
| `style-visibility-001` | QuickJS/V8 的可见性继承、显式子节点覆盖、真实像素与命中、unsupported winner 失败帧保留；software、CPU Skia 和真实 CanvasKit CPU 验证，官方 slot／GPU／七宿主门禁另计 |
| `style-overflow-001` | explicit overflow 的后代像素裁剪与坐标命中：双引擎 WXML/WXSS、独立 software/native Skia、单轴/圆角/嵌套/变换、失败帧保留；同一 accepted frame 可重放到真实 CanvasKit WebGL，官方及滚动门禁另计 |
| `style-border-001` | WXSS border shorthand/longhand 级联、content-box/border-box、四边宽色、currentColor/继承、圆角透明内孔、padding-edge overflow、变换和 setData；双原生引擎的 accepted frame 重放到 CanvasKit，未支持样式明确失败并保留旧帧；官方视觉/七宿主设备证据另计 |
| `style-render-001` | QuickJS/V8 动态 style → 真实 tap/setData → 当前 Page 数据 → 布局、computedStyle、RGBA 像素与命中范围 |
| `module-loading-001` | QuickJS/V8 CommonJS/JSON 声明依赖、缓存身份、循环 partial exports、错误、hash/graph 校验和 ESM 既有边界 |
| `module-lifecycle-001` | QuickJS/V8 加载入口模块、单次 `App.onLaunch` 与页面 onLoad/onShow/onReady/onUnload 批量回调 |
| `component-lifecycle-002` | QuickJS/V8 behavior `data()`、同名 component/behavior 生命周期顺序和 pageLifetimes payload 分发 |
| `component-page-visibility-001` | QuickJS/V8 自动 show/hide、导航与 tab 缓存、App 前后台、晚挂载、异常隔离和 reLaunch 清理；本地 Session 测试，不提升官方门禁 |
| `page-stack-001` | `getCurrentPages()` 在 QuickJS/V8 返回当前页面对象、route/options 查询快照和稳定页面栈顺序；页面替换/返回后移除失效注册 |
| `page-stack-002` | 同一路由重复 `navigateTo` 产生独立 page identity、data/setData 与 onUnload 目标，不串写相同 `Page` 定义 |
| `provider-system-001` | 系统信息由 host provider、启动选项由 app.init session state 以固定 schema 返回 |
| `provider-system-002` | getBatteryInfo 返回 level/isCharging，且遵守 deadline/cancellation |
| `provider-system-005` | getBatteryInfoSync 在 QuickJS/V8 中同步返回同一电池快照，保持 `getBatteryInfoSync:ok` envelope，且 capability 未协商时显式抛出 `ERR_UNSUPPORTED_CAPABILITY` |
| `provider-system-006` | getScreenBrightness/setScreenBrightness 共享 0..1 typed provider 状态，校验设备权限、无效值、deadline/cancellation，并在 QuickJS/V8 facade 中保持 callback/Promise 结果 envelope |
| `provider-system-007` | getSystemInfo/getSystemInfoSync 共享 typed snapshot；HostMetadata 有 displayMetrics 时采用实际屏幕、密度、状态栏与方向，windowWidth/Height 继续由独立 viewport 提供；无 displayMetrics 时保留原 sandbox snapshot。异步结果仅额外带 `getSystemInfo:ok` |
| `provider-system-008` | getDeviceInfo 使用校验过的 brand/model/ABI/CPU/memory/benchmark 快照并补入当前 host 的 platform/system，不添加未公开的 pixelRatio；getWindowInfo 另投影公开 screenTop，不添加 windowTop。宿主未确认 safeArea 坐标映射时省略 safeArea，不用 viewport 伪造；QuickJS/V8 使用相同快照 |
| `provider-system-003` | getMenuButtonBoundingClientRect 返回六个稳定几何字段；HostMetadata 可注入逻辑 CSS 像素，sandbox 无注入时返回零矩形 |
| `provider-system-004` | getSystemSetting 以同步快照返回 bluetooth/location/Wi-Fi 开关和 deviceOrientation；provider deadline/cancellation 仍在统一边界校验 |
| `provider-account-001` | getAccountInfoSync 在模块求值前注入 `{miniProgram:{appId,envVersion,version},plugin}`，sandbox provider 与 QuickJS/V8 facade 通过完整同步契约；mini-program context 使用 plugin={}；仅接受 develop/trial/release，未知 envVersion 返回 ERR_INVALID_REQUEST，facade 返回独立克隆快照；七宿主身份注入仍单独记录为 partial |
| `provider-share-001` | wx.shareAppMessage/wx.shareTimeline 在 QuickJS/V8 中保持单次批量 api.call、callback/Promise 结果和公开 `{errMsg}` envelope；sandbox 记录 typed ShareRequest 而不伪造用户完成 |
| `provider-share-002` | 分享选项类型、空 path/templateId、extraData、menus、share 权限、deadline/cancellation 在 provider 边界返回结构化错误，旧快照不会被无效请求覆盖 |
| `provider-network-001` | request/upload/download 的参数校验、seed 响应、文件落盘、超时、取消和权限错误保持结构化 |
| `provider-network-002` | connectSocket/SocketTask 的 URL 校验、OPEN/send/close 状态、确定性 socket id、权限和关闭错误保持结构化；sandbox 不伪造 inbound 消息 |
| `provider-network-003` | request/upload/download Task 的 thenable 兼容、abort 取消、headers listener 和 success/fail/complete 顺序在 QuickJS/V8 中一致；取消优先于同一 bridge turn 的 provider dispatch |
| `provider-filesystem-001` | provider 文件读写、UTF-8/base64、保存临时文件到显式或 SHA-256 内容寻址路径、删除和路径归一化 |
| `provider-filesystem-002` | getFileInfo 的 md5/sha1 摘要、getSavedFileInfo 元数据，以及 getSavedFileList 的稳定排序和保存文件生命周期 |
| `provider-filesystem-003` | QuickJS/V8 同步文件管理器读取、写入、存在性检查、删除、快照和 `api.sync` 批量变更效果 |
| `provider-filesystem-004` | QuickJS/V8 `getFileSystemManager().readdir/readdirSync` 的 dirPath 校验、目录前缀投影、稳定排序和空目录结果 |
| `provider-device-001` | 相机、媒体和定位在显式授权/拒绝时返回对应结果或错误 |
| `provider-device-003` | getLocation 校验 type/altitude，返回稳定位置结果字段，并保持权限、超时和取消错误结构 |
| `provider-device-004` | scanCode、startLocationUpdate/stopLocationUpdate 校验相机/位置权限和参数；sandbox 返回完整空扫码结果或稳定 `errMsg`，native provider 可替换资源实现 |
| `provider-media-005` | inner audio context 的 create/set/play/pause/stop/seek/destroy 状态机、属性范围和事件结果；sandbox 不伪造音频输出 |
| `provider-media-006` | audio component context 的 id 校验、setSrc/play/pause/seek 批量命令与 inner audio provider 状态一致性；sandbox 不伪造音频输出 |
| `api-unsupported-008` | 未协商 `wx.createInnerAudioContext` 或 `wx.createAudioContext` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `provider-media-007` | video context 的 create/play/pause/stop/seek/playbackRate/sendDanmu/fullscreen/status-bar 状态机、参数校验和 destroy 资源释放；sandbox 不伪造视频解码或渲染 |
| `api-unsupported-009` | 未协商 `wx.createVideoContext` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `provider-media-008` | camera context 的 create/takePhoto/startRecord/stopRecord/onCameraFrame 参数、权限和生命周期校验；sandbox 对获权但无设备的采集返回结构化 `ERR_UNSUPPORTED_CAPABILITY`，不伪造路径或帧 |
| `api-unsupported-010` | 未协商 `wx.createCameraContext` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `api-unsupported-011` | 未协商 `wx.getMenuButtonBoundingClientRect` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `api-unsupported-012` | 未协商 `wx.getAppAuthorizeSetting` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `provider-auth-001` | login/profile/payment/share 通过 provider 权限和 sandbox 结果 |
| `provider-auth-002` | `wx.login` 在 account permission 下建立 provider-owned session；`wx.checkSession` 在登录前返回稳定 session-expired 错误、登录后返回 `checkSession:ok`，并保持 deadline/cancel/host-restored session 语义 |
| `provider-auth-003` | `wx.getUserProfile` 在 profile permission 下要求非空 `desc`，返回完整 userInfo 与 rawData/signature/encryptedData/iv envelope；QuickJS/V8 facade 保持 desc 透传和 success/complete 顺序 |
| `provider-payment-001` | `wx.requestPayment` 在 payments permission 下校验非空 `timeStamp`/`nonceStr`/`package`/`paySign` 与 `MD5`/`HMAC-SHA256`/`RSA` signType，QuickJS/V8 facade 保持单次批量调用和 callback/Promise envelope；sandbox 记录 typed PaymentRequest，不联系支付服务或伪造用户完成 |
| `provider-device-002` | clipboard、网络类型、震动和保持屏幕常亮通过 typed provider；网络类型限定为公开枚举，keepScreenOn/震动选项校验后记录可复现设备副作用，clipboard/device 显式拒绝映射为 `ERR_PERMISSION_DENIED`；QuickJS/V8 facade 保持 battery 与 clipboard success/complete callback envelope |
| `provider-device-005` | `wx.onNetworkStatusChange`/`offNetworkStatusChange` 在 QuickJS/V8 注册、移除和批量回调；`Session::notify_network_status_change` 更新 typed provider 网络快照，并保持 `wx.getNetworkType` 与 callback payload 一致 |
| `provider-permission-001` | authorize/openSetting scope 校验、显式授权状态和稳定 `authSetting` 返回 |
| `provider-permission-002` | getAppAuthorizeSetting 将 camera/location/microphone/notification/album 状态映射为 authorized、denied 或 not determined，并遵守 deadline/cancel |
| `provider-permission-003` | `wx.getSetting`/`wx.openSetting` 校验 `withSubscriptions` 布尔值；启用时返回可注入且校验过的 `subscriptionsSetting.mainSwitch/itemSettings`，QuickJS/V8 facade 保持单次批量调用和 callback/Promise envelope |
| `ui-001` | showToast/showLoading 与对应 hide API 的参数校验、状态替换和稳定 `errMsg` |
| `ui-002` | showModal/showActionSheet/pageScrollTo/setNavigationBarColor 的返回结构、输入校验和 provider 状态记录 |

Rust 单元测试入口：

```sh
cargo test -p container-core -p container-runtime
```

这些测试验证 host-independent AppService/bridge 语义；它们不宣称官方微信
开发者工具、移动模拟器或真机渲染已经通过。
