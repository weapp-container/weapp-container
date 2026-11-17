# container-runtime

**简体中文** · [English](README.en.md)


`container-runtime` 负责一个可移植的迷你程序会话。它在启动前会验证支持的 `container-manifest` v1/v2/v3 输入，协商桥接协议 `1.x`，并在其所属线程上协调 AppService、视图和呈现状态：

- **AppService**：`container-core::ContainerRuntime` 负责生命周期、页面栈、导航以及批量数据补丁。
- **View**：`ViewState` 记录修订、失效以及帧/事件状态。
- **Rendering**：`SkiaPageBackend` 负责 Skia 预处理和候选项验收。它将已评估的 `ViewDocument` 实际化，而不进行 JS 评估或持有呈现权限。DOM 保留其浏览器的 CSS/几何信息/回执路径。`SessionConfig::page_render_mode` 默认为 `Raster`；编译渲染器的功能决定了软件渲染与原生 Skia 渲染的区别。外部帧和原生 GPU 模式具有独立的明确呈现合约。

Skia 页面对象仅在显式的具体或绘制边界处初始化。`renderer_if_initialized`、`page_render_mode`、`render_revision` 和 `renderer_backend` 会观察现有对象或其已验证的配置，而不会构造新的对象。普通的 DOM 加载、空快照检查以及解绑/重置操作都不会初始化页面渲染器。旧版 `renderer()` 会显式初始化 Skia；`renderer_mut()` 在暴露无限制的具体突变之前也会无效化浏览器呈现。这两个获取函数均不会授予浏览器呈现回执、几何授权或输入权限。Canvas2D 在页面初始化前使用独立的 `CanvasService`，然后在首次显式访问页面时，将该精确的命令/快照/字体所有权传递给具体渲染器。后续操作使用当前存储的渲染器；整个渲染器的替换无法恢复已退役的页面前存储。参见 [后端边界](../../docs/dual-renderer/skia-backend-boundary.md)。

宿主绑定通过 `container_bridge::BridgeEnvelope` 调用 `Session::dispatch`。
该方法始终返回一个 `BridgeBatch`；协议、能力、渲染和取消失败的错误以结构化响应信封形式返回，使用稳定的桥接错误码。`dispatch_result` 可供需要故障边界来处理会话创建错误的绑定使用。

当宿主在 `app.init` 中包含内容寻址的模块字节（或发送 `module.load` 批量请求）时，所选的原生提供者会通过会话拥有的命名注册表注册声明的 CommonJS/JSON 模块。每个提供的模块在进入评估前都会经过验证，并注册其工厂；模块本地的 `require` 仅解析由清单声明的依赖关系边。缓存的导出保持对象身份，包括 CommonJS 循环中的部分初始化导出。在应用执行前，使用所选引擎的 `JSON.parse` 检查 JSON 语法，保留 ECMAScript 数值和 UTF-16 语义。App、页面、组件和未引用的旧版批处理根节点会立即求值；作为依赖声明的模块在被 `require` 或显式 `module.call` 到达时进行求值。有界 ESM 适配器遵循源代码声明顺序，但不实现动态绑定、动态导入、导出星或涉及 ESM 的循环。不支持的语法和 ESM 循环会明确失败。
旧版急迫的 `load_module_with_id` API 保留了原子嵌套注册；在该事务内启动新的注册表工厂是不支持的，并在更改其缓存或注册前会抛出 `ERR_MODULE_LOAD` 错误。已经求值或正在求值的缓存模块仍可访问。提供者在求值前会安装标准的 `App`、`Page`、`Component` 和 `getApp` 注册全局变量；首个加载的 `app.js` 入口将跟随一次 `App.onLaunch` 分发，附带提供的 `launchOptions`。重复的 `app.init` 握手操作是幂等的，不会两次触发 `onLaunch`。握手响应中包含注册快照，因此宿主可以在无需猜测的情况下诊断缺少页面模块的问题。

引擎边界仅暴露已注册的 `wx` 接口代理，并将宿主操作作为批处理效果进行队列；原生绑定可通过文档中的 `api.call` 桥接直接发出相同操作。存储、定时器、导航、提供者回调和 `setData` 都以批处理方式跨越该边界。不支持的调用根据清单矩阵返回 `ERR_UNSUPPORTED_CAPABILITY`。

拥有会话的组件实例在其页面可见性变化时（包括导航、缓存标签页以及应用前台/后台事件）会收到 `pageLifetimes.show/hide` 通知。新附加的实例会继承可见页面的状态。专用的 QuickJS/V8 批量调用仅调用 pageLifetimes，隔离抛出钩子，并在进入用户代码前去重尝试。两种 reLaunch 入口点都会销毁活动和缓存标签页的实例。窗口大小改变不会合成组件大小变化的生命周期；官方交叉钩子顺序和完整的组件 API 一致性仍为独立的合规要求。

`HostMetadata.displayMetrics` 可选地提供一个观察到的显示快照，
与 `windowWidth/windowHeight` 分离，后者仍然是唯一的视口尺寸。
宿主在加载任何模块之前，将其安装到 `SessionConfig` 中。之后，
`Session::notify_window_metrics(HostWindowMetrics)` 接受一个完整的扁平化 JSON 兼容观察值，
在修改前进行验证，并在回调函数调用前刷新同步的 `wx` 缓存。
相同的观察值会被去重；仅当密度、方向、屏幕或内边距发生变化而逻辑视口未变时，不会重新触发视口调整。
页面数据、存储、定时器以及隔离环境仍由同一会话拥有。
旧版仅提供尺寸的 API 保留当前的显示元数据。
没有显示快照的宿主将保留历史沙箱默认值，这些值是辅助行为，而非设备测量值。

显示密度、屏幕范围、状态栏高度和方向信息由
`getSystemInfo`/`getSystemInfoSync`；`getWindowInfo` 还提供了观测到的 `screenTop`。运行时不会虚构 `windowTop` 或 DeviceInfo 的 `pixelRatio`。`safeArea` 是可选的：坐标和范围会经过验证并保留，而不会重新基准化；如果宿主无法建立其公共纵向坐标映射，则会省略该信息。目前 Android 会记录实际的原始内边距，并保持该映射未知。宿主的转换公式和舍入规则仍为实现合同，待固定版本官方对比后确定。

管理 `relations` 使用组合组件继承，包括插槽投影和原生包装器。共享的 QuickJS/V8 实现会在页面 onLoad 之前，在附加钩子收敛后，批量建立相互的 `parent/child` 或 `ancestor/descendant` 边缘。`getRelationNodes` 返回实时的隔离域实例；调用方接收独立的数组。所有已断开的钩子仍可查询旧图；然后两个表都会在回调函数解除链接前被清除。行为返回一个无透明的会话本地字符串标识符。嵌套行为成员关系、菱形去重、`hasBehavior` 和关系行为目标共享该身份注册表。

关系回调可能调用 setData 并触发另一个渲染前沿。
销毁和关系回调形成一个不可逆的生命周期边界：一个较晚的无效前沿会恢复最近已提交的活动拓扑，而不是一个其脱离钩子已运行的事件。用户 JavaScript 效果不会被回滚。声明的 `linkChanged` 回调在视图未提供物理移动标识之前会明确抛出 `ERR_UNSUPPORTED_CAPABILITY` 错误；压缩关系结果数组不被视为移动组件。
保存的 DevTools 3.17.3 预测仅约束投影祖先/后代的初始、移除和恢复生命周期序列。其他关系合约和所有宿主/设备声明仍为辅助性质。

管理组件 `triggerEvent` 使用协商的局部
`Component.triggerEvent` 能力以及在选定的隔离环境中发布的单个会话事件图。直接监听器和嵌套的自定义发射在同一个 JavaScript 执行周期内运行，保留本地详情对象的身份。捕获、冒泡和组合是可选的；传播在组件边界处停止，除非进行了组合，且 catch 监听器会阻止后续处理器。该事件图在生命周期/输入回调之前可用，且不需要渲染帧。监听器别名共享指针事件的拼写规则。保存的固定 SDK 生命周期比较 oracle 仅涵盖别名优先级和连字符/下划线名称；传播选项、详情身份、同步顺序和生命周期发射仍为本地合约，待官方差分证据确认后生效。有关精确证据范围，请参见 `docs/api-runtime-conformance.md`。

数据集和标记元数据保留了 WXML 已评估的 JSON 值，使用一个投影来表示原生树和管理组件事件图。选择器字段、观察器数据集和坐标输入读取已提交的元数据；已识别的联系人通过后续数据补丁保留 touchstart 快照。字面量和传统帧字符串永远不会被解析为 JSON。有关 Rust/wire 兼容性变更、null/存在限制以及剩余的官方合规工作，请参见
[事件元数据](../../docs/event-metadata.md)

宿主 `data.patch.batch` 请求在提交相同批次到 AppService/View 之前，更新 JavaScript 引擎中选定的实时 Page 实例。
具体的页面 ID 用于区分重复的路由实例。引擎镜像不会调用 `setData`、观察者或回调函数，也不会生成第二个补丁事件。点号键和方括号数组索引共享核心的带类型路径契约；错误的路径或未知页面在镜像更改之前就会失败。这证明了内部桥接的不变性，而非协议 `delete` 操作的官方 DevTools 等效性。模板/样式清单的替换保留了该状态；完整会话重启会重置该状态。

便携式沙箱将每个数组路径的长度限制在最多 1,048,576 个元素。无论是适配器还是 Rust，都会在分配前拒绝更大的索引，包括 JavaScript 无法精确表示的整数。此资源限制并非微信兼容性的官方声明。引擎镜像支持普通可写 JSON 数据。在任何批处理更改页面之前，预检会拒绝冻结的、不可配置的、访问器或自定义原型目标，并返回 `ERR_ENGINE`。任意代理陷阱和修改过的 JavaScript 内置对象超出了本事务的保证范围。

没有原生视图树的宿主可以提交基于清单的渲染提交。设置 `templateId`（或将其放在 `frame` 中），提供声明的 `blobs` 作为 SHA-256 密钥的字节数组/UTF-8 字符串，并包含可选的 `data`、`styleIds`、`viewport` 和 `frameId` 字段。会话将验证每个摘要，解码并评估 WXML，解析选定的 WXSS blobs，执行确定性布局，并提交一个渲染树批次。缺失或不匹配的 blobs 将返回 `ERR_RENDER`；明确的 `frame` 形式仍可供原生视图实现使用。

在基于清单的提交中省略 `data` 时，将使用当前页面的 AppService 数据，包括已接受的 `setData` 效果。显式指定的 `data` 值仍会作为覆盖。内联 `style` 和样式表声明共享一个级联结果：重要性、内联/选择器特异性以及源顺序决定了计算样式查询、布局、绘制和点击检测所使用的值。这些是本地可移植的协议；完整的 WXSS 和官方运行时等效性仍为部分实现。

布局声明在级联之前会经过验证并展开简写形式。
在排版确定后，输入的块级/弹性容器尺寸会保留包含块的百分比和auto值，供共享的渲染器求解器使用。这包括增长/缩小/基线、换行、对齐、边距以及最小/最大约束。非法的不支持值会拒绝该候选方案，而不是静默地绘制另一个布局。参见 [布局合约](../../docs/layout-flow.md)。

WXSS IR v2 保留了导入位置和条件组。在级联之前，运行时会在每个位置展开前置的本地导入，并将媒体条件与帧的逻辑视口进行对比。匹配的普通规则保持源顺序；不匹配的组不会渗入元素样式。宽度/高度、方向和长宽比查询使用文档中定义的可移植子集。活动的 `@supports`、未知的 at-规则以及延迟/嵌套导入返回 `ERR_UNSUPPORTED_CAPABILITY`。字体和关键帧元数据被保留，但不实现字体加载或动画。旧版 v1 的导入仍会在其所有者的规则之前展开，且无法恢复丢失的源位置或组上下文。本地 `.wxss` 和 `.css` 资源使用相同的解析器，与打包器保持一致。有关查询语义和资源失败的详情，请参见 [WXSS 合约](../../docs/wxss-ir.md)。

Solid WXSS 边框现在会独立地将宽度/样式/颜色边框投影到共享的渲染模型中。CSS content-box 是 WXSS 的默认值；显式设置 border-box、padding、currentColor/继承以及 padding 边缘的溢出裁剪会传递给布局、像素和输入。其他合法的边框样式会拒绝候选帧，而不是假装绘制实线边框。之前被接受的帧在被拒绝后仍会保留。有关支持的值、旧版帧默认值以及剩余的 oracle/宿主差距，请参见 [边框合约](../../docs/wxss-borders.md)。

支持原生的会话拥有一个独立的视图引擎，用于批量渲染 WXML/WXS。经过验证的视图模块永远不会进入 AppService。保留的渲染票据可防止组件发现重复执行有状态的工作，销毁操作会释放精确的范围。对 WXS 文档/程序的编辑会重启会话；仅样式预览会复用缓存的 AST。没有模块元数据的旧版 WXS 仍不支持。有关视图合约的预算、故障和方言限制，请参见 [视图合约](../../docs/isolated-view-engine.md)。

开发验证工具独立于生产运行时运行。
兼容性声明需要版本化行为和符合性证据。

JavaScript 提供商是显式的 Cargo 特性。`quickjs-native` 链接原生 rquickjs 适配器；没有它，默认的 QuickJS 会话仅作为一个协议层面的无界面边界，用于清单/合规性测试。`v8-native` 链接了固定化的 rusty_v8 适配器，并将它的隔离器存储在会话中。没有该特性的 V8 会话在构建时会抛出 `ERR_ENGINE` 错误；它不会回退到 QuickJS。

可选的 `restricted-showcase` 特性会构建一个独立的演示版本。它在编译时需要一个绝对路径的 `WEAPP_SHOWCASE_POLICY`；缺少或无效的策略将导致构建失败。该策略恰好包含三个字段：`schemaVersion: 1`，一个非空的 `allowedPackRoots` 数组（包含清单完整性根路径），以及一个非空的 `allowedApis` 数组。包的完整性始终会被验证，运行时和 SDK 在执行前都会拒绝未经批准的包。API 列表是一个编译时的上限，宿主提供方无法覆盖。在该版本中，开发诊断、任意宿主方法调用、包替换和更新授权功能均被禁用。当相应应用 API 被允许时，宿主消息仍可使用。

使用 `--distribution-profile restricted-showcase --showcase-policy /absolute/policy.json`
配合 `scripts/build-web-wasm.mjs` 或 `scripts/sdk-native-build.mjs`。这些生成器需要在发布模式下运行，关闭视图诊断，保留私有的标准策略，并在编译后的产物中验证其身份。报告和归档文件将携带 `distributionProfile` 和 `policySha256`；消费者需要显式匹配的受限身份，因此展示用二进制文件无法满足完整 SDK 依赖。平台归档安装可接受相同的显式配置文件并使用 `--policy-sha256`。这一边界限制了交付的能力；编译后的二进制文件仍允许逆向工程，且不提供源码加密。

原生 Skia 展示生产者还需要 `--showcase-font /absolute/NotoSansSC.ttf`
和 `--showcase-font-license /absolute/OFL.txt`。生产者和 Rust 构建脚本都会验证固定的已审核哈希值；直接使用 Cargo 构建会提供与 `WEAPP_SHOWCASE_FONT` 和 `WEAPP_SHOWCASE_FONT_LICENSE` 相同的输入。原生二进制文件会嵌入这些字体字节，并在首次 Canvas 操作或页面布局之前安装一个独占的字体提供者。独立的 Canvas 所有者会将该提供者移入懒加载页面渲染器。Windows 字体注册和系统 CJK 字体对于此分发方式是不必要的。原生回执会验证编译后的字体身份和实际字体字节；归档文件会保留 OFL。完整的运行时保留宿主字体，Web 保留其明确的可移植字体。

在评估管理模板之前，运行时会批量刷新引擎中的当前实时组件快照。这使得 JS 数据修复能够在无需先评估过时缓存数据的情况下，恢复之前无效的前端。被拒绝的帧会保留上一帧的渲染结果；已经完成的脱离/未链接回调仍保持完成状态，而恢复操作会保留最新的已提交实时拓扑结构。

`Session::accepted_page_observation()` 获取一个已接受的 Skia 帧、其渲染修订版本、其固定提交目标以及任何缓存像素，但不初始化页面渲染器、评估视图或克隆缓冲区。
`page_render_status()` 报告配置、分配、持续时间和绘制表面标志；`has_metal_context()` 是在 Metal 构建上的被动附加查询。
空后端没有已接受的观察结果，并报告零/假运行时状态。这些事实不赋予任何当前路径、输入、就绪或浏览器权限：一个保留的帧可能属于前一个页面。

`render_target_for_revision()` 仅接受精确的当前非零 Skia 渲染修订版本，不接受应用帧 ID 或 DOM 修订版本。当页面提交成功时，其目标会被固定。阶段密度、被拒提交、Canvas 绘图和诊断快照均不能改变这一固定状态。该目标描述了已接受的配置/提交；它不测量宿主帧缓冲区，也无法证明 GPU 绘制呈现。`render_snapshot()` 是一个明确的克隆/诊断请求，并保留外部帧模式的按需软件快照行为；借来的观察仅暴露已缓存的像素。公共的具体渲染器获取方法仍可供兼容性使用以及显式旧版初始化/修改。

<a id="asynchronous-sdk-host-contract"></a>
## 异步 SDK 宿主合约

`HostApiProvider::start_call` 默认返回现有同步 `call` 的结果。provider 可返回 `ProviderStart::Pending` 发布 `HostRequest::Call`，避免阻塞运行时。在运行时 turn 结束后，通过 `Session::take_host_requests()` 取出请求，在外部执行传输和业务操作，再将 `complete_host_call` 排入原 owner 线程。turn 执行期间，传输回调绝不能重入会话。`api.result` 接受相同的不透明 `callId`，以及 `result` 或序列化的 `ProviderError`；未知、重复和前代 ID 返回 `accepted:false`。

在 `app.init` 之前，使用 `set_host_methods` 注册精确的方法名称。
AppService 代码使用 `weappContainer.invoke(method, payload, {timeout})`、`postMessage`、`onMessage` 和 `offMessage`；宿主通过 `send_host_message` 发送入站消息。负载是 JSON 值。HTTP 请求的字节体和结果内部使用 `dataEncoding:"bytes"`，wx facade 会重建 ArrayBuffer 结果。API 类型定义位于 `sdk/contract/types/weapp-container.d.ts`。

默认业务截止时间为30秒，提供者截止时间为60秒；
正向的 `timeout` 毫秒值以及更早的绝对截止时间可能覆盖该设置。
宿主使用 `next_host_deadline_ns` 安排 `poll_host_timeouts`，独立于呈现循环，包括在隐藏时。
取消、超时、关闭和完成操作将每个待处理调用一次性结算。`cancel_host_calls` 是最终操作；它会丢弃未发送的工作，并对已交付的工作发出取消通知。
限制包括：最多256个待处理调用、1024个出站条目（包括预留的取消容量）、64 MiB的聚合排队负载、1 MiB的业务负载以及256个JS消息监听器。HTTP完成的JSON数据大小最多为64 MiB。

存储仍属于会话所有。`restore_storage` 必须在 `app.init` 之前执行；
`storage_snapshot` 将未定义与 null 分开保存，
`storage_revision` 让 SDK 可以序列化写入操作。磁盘持久化和持久的刷新确认属于 SDK。替代方案候选者的宿主出站消息和存储影响在该候选者被提交前仍保持私有。
