<a id="browser-presentation-v1"></a>
# 浏览器呈现 v1

**简体中文** · [English](browser-presentation.en.md)


此主线程协议将评估的 `ViewDocument` 值连接到真实的 DOM 布局。它是一个实现里程碑，而非七宿主、性能或微信功能的等效结果。开发 CLI 在 `--surface web --renderer webview --web-runtime remote` 模式下附带了该协议；其测试和证据与仅用于验证的 JSONL 驱动程序是分开的。

<a id="ownership-and-transaction"></a>
## 所有权和事务

宿主明确启用 `SessionConfig.browser_view_enabled`。页面配置选择仍来自协商的清单或宿主覆盖。
应用程序模块、视图评估、组件所有权和事件监听器仍在运行时。浏览器负责布局、命中测试和原生滚动。
DOM 准备在 Rust 中不会级联样式，将图片解码到 Skia 缓存，运行 Taffy，提交 Skia 页面或读取页面像素。

桥接操作在运行时线程上使用 `HostSession::dispatch` / `dispatch_json`。它们继承了桥接会话/协议验证、截止时间、取消、存储同步以及故障路径效应的耗尽。底层的 `Session` 呈现方法是事务原语；宿主不得将它们用作 JavaScript 任务边界替代方案。

模拟器的拥有线程在预览租约发生变化时也会调用 `HostSession::retire_browser_preview`。这个宿主边界会取消捕获的触摸操作，撤销呈现权限，并在发布新的文档请求前清除回调效果。它不会将 AppService 放入后台，也不会停止计时器。

<a id="development-preview-ownership"></a>
## 开发预览版所有权

`POST /api/preview` 接受 `{version,requestId,clientId,op,epoch?}` 用于
`connect`、`claim`、`heartbeat` 和 `release`。HTTP 202 仅用于准入；
`preview` SSE 事件是主线程的结果。租约持续 15 秒，预览会每 5 秒发送一次心跳。
所有者变更、过期和所有者重新连接将在推进标准十进制纪元和绘制表面生成之前终止运行时权限。`viewAuthority.previewEpoch` 将状态发布绑定到其租约；预览结果无法激活旧的权限。

释放和过期时间在DOM到Skia的切换后仍然可用。已退役的释放回执是受限的，不能撤销后续所有者的权限。一个只读客户端，如果在不变的纪元中使用相同的客户端ID重新连接，其后续的释放可能会被分类为重复项；此时其记录将在15秒的TTL后过期。新的绘制表面实例使用新的ID。这是一次受限的清理延迟，而不是对这种重连情况的即时释放保证。

DOM 桥接请求携带一个仅限宿主的顶层数据
`preview:{clientId,epoch,requestRevision?}`。 每个 `view.*` 封装在 HTTP 入口处被限制，并在立即派发前再次限制。`view.prepare` 也必须与不可变的最新请求版本、渲染负载和生成版本匹配。该版本在浏览器启动准备时捕获，而不是从后续可变状态中采样。此元数据永远不会进入运行时协议。
DOM 呈现设置还需要当前所有者限制。

只有拥有者执行运行时准备、几何更新或输入操作。镜像在本地显示运行时已验收的文档，且输入被禁用。传输需要在启用新拥有者输入之前进行一次新的事务。没有标签可以通过重用页面 ID 来恢复旧的演示。编码的图像资源由完整的演示密钥和哈希授权，并在飞行响应中共享，直到最后一个响应释放它们才会被计入网络缓存预算。清除缓存不会使仍被保留的响应缓冲区变为可用。

视图请求变更必须通知浏览器，即使定时器返回空桥接批处理也是如此。请求状态和确认状态是分别追踪的：由 ready 触发的 `setData` 会提交另一个修订版本，而不是被标记为已渲染。密度变更会保留已接受的文档；逻辑缩放和成功原地重载会调度新的布局。即使在 Rust 重载预检之后，仍可能发生仅浏览器的 CSS 或解码失败；前一图像会被保留，无效输入会保持挂起状态。在实时清单替换前完成完整的浏览器预检仍是一个独立的实现要求。

| 操作 | 请求数据负载 | 成功响应数据负载 |
| --- | --- | --- |
| `view.prepare` | `{version:"1.0",surfaceGeneration:"1",render:{templateId,viewport,useSessionResources:true}}` | `{ok:true,submission:{version,key,viewport,document}}` |
| `view.prepare.commit` | `BrowserGeometryBatch` 在隐藏的准备 DOM 候选中测量 | `{ok:true,permit:{version,key,epoch,permitId}}` |
| `view.presented` | 浏览器确定候选方案后的精确许可 | `{ok:true,key,inputEnabled}` 加上生命周期/效果诊断信息 |
| `view.abort` | 精确的待处理 `PresentationKey` | `{ok:true}` |
| `view.geometry` | `BrowserGeometryBatch` 用于已验收的文档 | `{ok:true}` |
| `view.events` | `{version:"1.0",key,epoch,events:[...]}` | `{ok:true}` 加上已消费/丢弃的计数、影响和诊断信息 |

流程是：准备文档 → 隐藏 DOM/布局 → 运行时许可 → 浏览器提交 → 运行时回执 → 浏览器确认。一个排队的 HTTP 响应不是许可或最终回执。浏览器在收到确认前会保留之前的文档及其资源。一旦运行时确认发布，即使准备钩子失败，元数据也不会回滚。`inputEnabled:false` 确认了显示的文档，同时保持输入挂起；恢复需要一个新的有效事务。

`PresentationKey` 绑定会话、页面、文档版本、演示文稿版本、绘制表面生成和配置文件。本协议中的每个 u64 都使用标准十进制字符串。较旧的 `ViewDocument` v1 数值标识符仅在 JavaScript 的安全整数范围内被接受。几何信息必须包含确切的权威文档实例，包括文本节点。重复的纪元仅在其完整内容完全匹配时才是幂等的；更改后的批次需要一个严格更新的纪元。

<a id="input-and-retirement"></a>
## 输入和退役

浏览器事件携带 `type`、`targetOccurrenceId`、`detail`，可选的 `timeStamp`、`touches` 和 `changedTouches`。每个触摸事件携带 `identifier`、`x`、`y`、`clientX`、`clientY`、`pageX`、`pageY`。坐标和时间必须为有限值；标识符必须是安全整数，并在每个有限触摸列表内唯一。运行时从其不可变的评估拓扑中推导出处理器、传播路径、捕获策略、组件所有者、数据集和标记。线程不将这些作为宿主权限接受。在调用回调前会验证整个批次。每个事件的效果在接收下一个事件前应用，因此导航不能使后续输入指向旧页面。回调失败会保留已提交的数据/存储效果以及已消耗或丢弃的回执。

消耗 `touchstart` 事件会获取原始事件拓扑和最新坐标的拥有接触。终端事件在回调前会消耗该所有权，延迟的终端事件无法重放该所有权。在重建或生命周期终止前，运行时会向原始接收者发送一个合成取消事件，即使失败也能保留回调效果和诊断信息。目前完整的 DOM 重建会结束手势操作；跨文档的连续手势迁移功能仍待实现。渲染请求应使用权威页面数据，而不是提供在取消钩子之前捕获的快照。

manifest 替换，逻辑缩放，页面隐藏/卸载，应用隐藏/卸载，组件图无效/销毁以及不受限制的宿主存储突变会退旧授权。返回相同的缓存 PageId、尺寸或 manifest 无法使其恢复。后台/已销毁的应用程序无法准备新的呈现。最后一帧图像可能仍可用于诊断，而输入和几何访问将被暂停。旧版 `render.commit` 和数值 Skia 回执无法发布 WebView 页面或提前触发就绪。

浏览器客户端允许一个几何请求和一个最新的待处理几何作业。事件保持与已接受的时钟周期关联，并等待其确认，最多可容纳256个事件。本地已废弃的工作将被丢弃，不会产生错误覆盖；实际运行时故障仍被视为错误。精确请求超时的标记被限制，仅能中止一个延迟的待处理候选者。在最终确认后，清理失败将保留新图像并暂停输入；它无法恢复旧的绘制表面，也不能让延迟超时撤销发布。

<a id="resources-and-remaining-adapters"></a>
## 资源和剩余适配器

`HostSession::browser_view_resource(key, sha256)` 仅暴露由该待处理/已验收文档声明的资产的借阅编码字节。知道内部脚本或样式表 blob 的哈希值并不授予访问权限。传输必须保留不可变的资源租约，并独立于帧元数据来执行字节/缓存预算控制。

Browser-backed SelectorQuery 现在有一个部分适配器，该适配器通过明确的接收方协商进行控制；它会匹配评估的文档，并请求新的浏览器测量值，而不是重用已验收的输入几何体或旧的 Skia 帧。在 `app.init` 之前，工作线程启动可以主动选择启用此功能；远程初始 `onLoad` 没有接收方，且在预览的实际呈现握手之前均不支持。详情请参见 [DOM 查询协商和证据](browser-selector-queries.md)。
交集观察器和滚动命令仍需要专用的 DOM 适配器，并返回结构化的不支持错误。这些路径中任何都不能借用之前 Skia 页面的几何体。

媒体查询使用正向的宿主逻辑视口尺寸，而不等待DOM候选或最终确认。它们永远不会回退到之前的Skia帧。未知的宿主尺寸会保留待处理的观察结果，直到获得有效的指标；密度和仅显示相关的更改不会产生逻辑媒体转换。两个配置文件共享现有的观察者所有权、隐藏页面订阅、断开和销毁规则。

`Session::browser_page_input(key)` 为一个确切的实时候选或已验收的呈现提供本地根数据来源。当页面数据被克隆时捕获快照，之后任何接触取消后的重新读取操作也会在此基础上进行，且后续组件钩子、就绪回调、几何更新或确认回执（ACK）不会升级此快照。明确的渲染数据和分离的预览不会获得页面快照。这使得模拟器可以避免冗余的重绘，同时保留根快照之后写入的更新。它不是呈现许可，也不是异步观察租约。

`pnpm host:webview:media-smoke --binary <simulator> --engine quickjs|v8 --out
<new-directory>` 启动一个独立的无头浏览器中的参考应用副本。它检查渲染的媒体回调、逻辑性尺寸调整、尺寸不变、渲染缩放变化和断开连接。报告保留了测试用例、可移植包、二进制/源码哈希和清理结果。实际浏览器的DPR过渡、官方行为和性能保持独立的验证门。

本地故障注入测试和协议示例是辅助证据。
原生 WKWebView/WebView2/WebKitGTK/Android WebView/ArkWeb，浏览器 Worker 模式，
混合组件、官方预言机和硬件/性能门禁仍处于冻结的目标范围内。

<a id="running-the-protocol-example"></a>
## 运行协议示例

构建 `container-host-common` 的 `dom-protocol` 示例，使用
`--features container-runtime/quickjs-native,container-runtime/v8-native`。
它读取一个已存在的可移植包，使用 `--pack <directory> --engine quickjs|v8`，
验证其清单和数据块哈希，初始化真实应用，并将 `HostSession` 保留在其 stdin/stdout 所属线程中。
其第一条 JSON 行是启动元数据；后续行是 stdin 和 stdout 上的完整桥接请求/响应信封，以及 stdout 上的响应批次。
它不提供 HTTP 服务器，也不连接到用户的浏览器。

配套测试运行一个拥有临时 HTTP 服务器和无头 Chromium：

```sh
node scripts/dom-runtime-browser-smoke.mjs \
  --pack <portable-pack-directory> \
  --driver target/debug/examples/dom-protocol \
  --engine quickjs --out artifacts/dom-runtime-quickjs
```

使用参考或现代的 View 示例包，该包暴露了一个 `increment` 按钮和一个数值型的 `count`。测试会记录实际的 DOM 几何信息、屏幕截图、桥接/生命周期追踪、输入效果以及缺少 Skia 页面帧。在成功或捕获到失败时，它会关闭自己的浏览器、服务器和运行时进程。此测试未涵盖强制终止和信号中断恢复。每次运行都应使用一个全新的输出目录，以便保留失败的证据。

`pnpm host:webview:test` 运行浏览器事务和传输单元测试。
现有的 `modern-view` CI 任务会构建真实示例包，并在 QuickJS 和 V8 上运行协议示例。工作流定义不是 CI 执行的证据；运行器结果单独记录。

<a id="development-supervisor-integration"></a>
## 开发-监督器集成

开发主管在准备渲染请求并应用打包时，会选择当前页面的配置。DOM 准备在运行时所有者线程上读取当前页面数据。最终的回执可以运行就绪钩子以更改数据；由此产生的修订版将生成自己的渲染请求。

拥有者循环和桥接 SSE 传输将 DOM 操作与 CanvasKit 的数值回执路径分开。共享的服务器状态暴露了实际的页面配置文件和字符串值的权限身份。编码的 DOM 资源使用单独的端点，并与正在传输的响应共享有界的缓存预算。配置文件切换会终止前一个后端的保留发布和回执；HTTP 响应在其释放资源之前会持续计费资源字节。

只有单个预览拥有会话的 DOM 准备和输入。镜像显示已验收的文档，并禁用输入；明确的声明会在新交易启用输入前退掉旧的所有者。重新连接也需要新的交易。DOM 绘制表面使用自己的事件通道，并退掉 Skia 监听器。Skia 输入等待最终运行时 SSE 结果，而不是将 HTTP 队列回执视为成功。

`simulator-dom-browser-smoke.mjs` 对真实的时间戳/刷新、缩放、重连、所有权和清理操作进行了测试。`simulator-mixed-renderer-browser-smoke.mjs` 在不同密度下测试了同一会话中 DOM/Skia 的导航和输入操作。报告将每个结果绑定到其二进制文件和源码。一个清单替换会废除旧的 DOM 权威性；保留其图像并不会回滚组件的副作用。DOM 的清晰度跟随浏览器的 DPR（设备像素比），因此 Skia 渲染缩放设置不会被呈现为 DOM 超采样。这些开发测试并不能认证其他宿主、物理 GPU 行为或性能预算。
