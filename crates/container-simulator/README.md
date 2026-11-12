# container-simulator

**简体中文** · [English](README.en.md)


明确的 [现代 JS/TS View 配置文件](../../docs/modern-view.md) 支持在独立运行域中运行同步 ES2022。运行示例时请使用 `dev --project examples/apps/modern-view-app --surface web`；仅现代功能的编辑会独立重新打包，可执行代码的变更将重启会话。传统 WXS 保留其自身的语义和兼容性证据。

`container-simulator` 是一个本地、确定性的开发工具，用于打包的 `weapp-vite` 应用程序。它加载与原生/网页宿主相同的 `manifest.json` 和内容寻址的 blob，然后通过批处理桥接消息驱动一个 `container-host-common::HostSession`。

原生 QuickJS/V8 会话在独立的 View 运行时中评估声明的 WXS，保留页面/组件状态和整个文档的渲染批处理。样式重新加载会复用已评估的工作；WXS 文档/程序变更将重启会话。没有 View 模块元数据的旧版包仍不支持。有关执行和方言限制，请参见[隔离的 View 合约](../../docs/isolated-view-engine.md)。

旨在提供快速开发反馈和可重现的合规性测试环境。绿色模拟器报告是无界面的证据；它不能认证官方微信开发者工具、GPU 绘制表面、模拟器或物理设备。

`web::DevRasterWebSession` 是一个独立的、明确的库入口，用于在单个运行时中实现有票软件的 Raster HTTP/SSE/ACK/input 功能。实验性示例 `serve_dev_raster` 拥有独立的端口和清理机制。它不启用正常 CLI，不将旧版 HTML 附加到二进制帧 v2，也不提供浏览器/GPU 验收。详见 [严格协议、限制和生命周期](../../docs/dev-raster-http.md)。

<a id="browser-runtime-preparation-for-embedding"></a>
## 浏览器运行时嵌入准备

`DevConfig.browser_runtime` 显式将 `BrowserWorker` 监控器配置为静态准备一个独立固定完成的 Worker 生产者。监控器拥有有界输入副本、工具、有限任务和原始验证的资源字节。`BrowserRuntimePrepared` 仅报告静态就绪状态；`runtimeReady` 和 `presentedReady` 仍为 false。释放资源借用人，并重试 `try_shutdown()` 直至确认清理完成。示例命令 `cargo run -p container-simulator --example prepare_browser_runtime -- <project> <producer> <pins.json>` 驱动此实际监控器路径。参见 [输入固定点、限制和生命周期](../../docs/dual-renderer/browser-dev-artifacts.md)。此操作不会启用浏览器监控 CLI 或启动 Worker/浏览器。

设置 `DevConfig.managed_browser_sources = true` 可以使用显式拥有的编译器 → 原始输入 → 可移植输入流水线，并在同一个artifact ledger中运行。
该示例在pin文件之后接受 `--owned-sources` 参数，并等待验证的 `PortableReady`。此配置需要冻结的供应商编译器、QuickJS、独立的运行时pin以及没有 `container.config.json` 的项目；它明确拒绝自定义构建器和现代View输入。当新构建失败时，之前的有效包仍会被保留为拥有状态。在父进程清理前，监视器/进程屏障和实际输入借阅者必须完成清空；清理失败可重试。
该配置为根/输入/工具、一个运行时、两个原始输入和两个可移植输出保留逻辑容量，并包含一个有限的artifact任务。它不接受浏览器站点或阶段。参见 [拥有源准备](../../docs/dual-renderer/browser-source-preparation.md)。

`DevConfig.managed_browser_stages = true` 此外还允许在同一账本上执行实际的
`stage-pack` 任务。`begin_browser_stage` 在观察源之后借取当前拥有的可移植生成版本；`poll_browser_stage` 返回一个已验证的静态 `StageArtifact`。`browser_stage_resource` 借取原始捕获的字节和费用。两个阶段槽位包含已退化的站点，其主体仍被借取；释放主体并重试退化/关闭操作。
可执行示例为 `prepare_browser_stage`。该配置不启用 HTTP、浏览器 CLI、Worker 执行或呈现。参见 [消费阶段](../../docs/dual-renderer/browser-consuming-stage.md)。

## CLI

先构建一个包：

```sh
pnpm container:pack -- ./dist/weapp --out ./artifacts/reference
```

运行标准启动路径（app.init、launch、page.push 和基于清单的 render.commit）：

```sh
cargo run -p container-simulator -- \
  run --pack artifacts/reference \
  --data-json '{"message":"hello from simulator","count":0}' \
  --trace artifacts/simulator/trace.json \
  --snapshot artifacts/simulator/snapshot.json \
  --report artifacts/simulator/report.json
```

重放一个 JSONL 桥接脚本。每条非空行对应一个 `BridgeEnvelope` 或一个 `{"messages":[...]}` 批量消息：

```sh
cargo run -p container-simulator -- \
  dispatch --pack artifacts/reference --script scripts/dev-script.jsonl
```

相同的 `--script` 选项可以跟随 `run` 的标准启动生命周期，这对于确定性引擎和宿主固定测试用例非常有用：

```sh
cargo run -p container-simulator --features quickjs-native -- \
  run --pack artifacts/reference \
  --script fixtures/engine-conformance.jsonl
```

<a id="development-mode"></a>
## 开发模式

从仓库根目录开始，在首次运行前准备固定的编译器：

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite run build:pkgs
pnpm submodule:verify
```

使用 `vendor/weapp-vite/package.json` 中声明的 Node 和 pnpm 版本。
单独安装根包不会构建供应商编译器。详见
[准备说明](../../docs/simulator.md#开发态监督器)。

`dev` 通过一个独立的公共 API 适配器启动了固定化的 weapp-vite 监听器。
该适配器在构建完成事件期间冻结输出，并发布版本回执。监督器仅打包这些不可变的快照，并通过本地绘制表面提供最新验证的版本：

```sh
pnpm simulator:dev -- \
  --project examples/apps/reference-app \
  --surface web
```

`pnpm simulator:dev` 使用发布版构建，而应用程序源码保持在监视模式。使用 `pnpm simulator:dev:debug` 进行 Rust 调试。对应的 Cargo 命令是：

```sh
cargo run --release -p container-simulator -- \
  dev --project examples/apps/reference-app \
  --surface web --host 127.0.0.1 --port 5179
```

默认地址是 `127.0.0.1:5179`。使用 `--host` 和 `--port` 可以更改 Web 监听地址，使用 `--out-dir` 选择生成目录，使用 `--wv-bin`/`--node-bin` 时工具不在 `PATH` 中。`--open` 会要求默认浏览器打开 `web` 或 `both` 的 Web URL。其启动器会在后台运行并被回收；失败时会打印手动 URL 而不会阻塞模拟器。页面暴露了 `/api/state`、`/api/frame`、兼容性接口 `/api/snapshot`、`GET/POST /api/presentation`、`POST /api/bridge` 以及 SSE 流 `/api/events`。

<a id="local-gpu-scene-presentation"></a>
### 本地 GPU 场景呈现

开发网页预览现在默认使用浏览器本地的 CanvasKit/WebGL2。原生的 QuickJS/V8 会话导出一个已验收的场景批次以及单独处理的图像资源；该路径不会对页面大小的 RGBA 图像进行光栅化或传输。`--software` 显式恢复旧的 CPU 预览。`run` 和 `dispatch` 保持其确定性的无头默认设置。

使用 `--features desktop-window --surface desktop` 时，macOS 使用 Metal 呈现器，Windows/Linux 通过 glutin 使用 OpenGL 3.3 core drawable。所有呈现器借用同一个运行时会话，保留呈现 ACK 与输入坐标边界。GPU 初始化失败不会自动切换到 CPU；`--software` 显式选择 winit/softbuffer。详见[桌面窗口契约与 display 测试](../container-host-desktop/README.md#native-gl-windows-on-windows-and-linux)。

准备一次固定的公共渲染器/字体依赖项，然后通过 `--renderer-assets`（或 `WEAPP_CONTAINER_RENDERER_ASSETS`）传递资源包：

```sh
node scripts/prepare-canvaskit-dev.mjs \
  --canvaskit-dir <canvaskit-wasm-0.42.0> \
  --font-file <pinned-NotoSansSC.ttf> --font-license-file <OFL.txt> \
  --out-dir artifacts/dual-renderer-dev-assets
```

依赖哈希值在
`examples/hosts/web-wasm/renderer-dependency-pins.json`。缺失或不匹配的资源在观察器启动前会失败；不会发生软件回退。默认的捆绑包位置是相对于本仓库的 `artifacts/dual-renderer-dev-assets`。

`GET /api/render-frame` 返回一个版本化的布局批次。二进制图像 URL 限制在已接受的会话/版本/修订版本范围内。`POST /api/render-presented` 将回执加入队列；运行时线程 `presented` SSE 事件将确认该操作。输入、就绪钩子以及选择器/观察器几何体等待匹配的呈现。普通的 CanvasKit 提交不会调用 `gl.finish()`；诊断快照可能需要显式同步。实际的硬件加速仍需要观察到的 GPU 证据，且与 WebGL 上下文的创建独立。

`--renderer auto|skia|webview` 选择默认/每页的清单配置文件或显式覆盖。远程 Web 绘制表面支持 CanvasKit 和 DOM：

```sh
pnpm simulator:dev -- --project examples/apps/reference-app \
  --surface web --renderer webview --web-runtime remote
```

显式 `webview` 不需要 CanvasKit 资产。`auto` 仍会准备 CanvasKit 资产，以便路由可以切换配置。浏览器布局在隔离的 iframe 中运行；AppService 和视图执行仍在本地 QuickJS/V8 运行时线程上进行。DOM 路径使用编码的基于内容的图像，从不使用页面的 RGBA。只有运行时确认的呈现才能启用输入和就绪钩子。

一个选项卡是活动预览。其他选项卡显示已验收的文档，没有运行时输入或几何权威。 “设置为活动预览”会退租旧的租约并在新呈现之前进行触达；重新连接也需要新的事务。`POST /api/preview` 队列租约操作，最终结果通过 SSE 返回。`/api/view-resources/<sha256>?key=...` 使用完整待处理/已验收呈现密钥对编码资源进行授权。在运行时分发之前，会拒绝过期的租约和过期的准备请求修订。

DOM 使用浏览器的原生 DPR。其密度选择器已禁用；显示缩放、逻辑尺寸和目标更新帧率仍可用。更改已保存的密度偏好不会重新评估视图函数或对 DOM 进行超采样。逻辑尺寸调整会调用运行时钩子，并等待新的浏览器几何信息。

普通的 CLI 现在共享管理的浏览器开发运行器：

```sh
cargo run --release -p container-simulator -- \
  dev --project /absolute/raw-mini-program-project \
  --surface web --engine quickjs --renderer webview --web-runtime browser \
  --browser-runtime-dir /absolute/completed-worker-producer \
  --browser-runtime-pins /absolute/independent-pins.json \
  --node-bin /absolute/node --port 0 --open
```

使用相同的 CLI 命令，配合 `--renderer skia` 参数来选择 Worker + CanvasKit/WebGL2。
Skia 需要一个已完成的 Worker 生产者，其独立的 pin 指定为 `"renderer": "canvaskit"`；请使用其对应的 `--browser-runtime-dir` 和 `--browser-runtime-pins` 配对。WebView 可接受独立 pin 的软件或 CanvasKit 生产者。原始的 `serve_browser_dev` 示例保持其 WebView 启动配置。

这些明确的 QuickJS Worker 配置支持 `--route`、对象 `--data-json` 和整数 `--viewport`（每边最多 4096，默认 375×667）。
它们不需要原生 QuickJS 功能，也不读取保存的远程呈现偏好设置。Skia 支持 `--render-scale auto|1|1.5|2|3|4`（默认为 auto，由拥有预览的显示密度决定，并上限为 2）。其精确的物理帧目标与逻辑视口和模拟 `pixelRatio` 无关；被拒绝的目标预算会保留已接受的目标。WebView 使用浏览器密度，并拒绝显式渲染缩放。浏览器模式下的 Skia 在启动时仅解析一次 auto。对于浏览器模式，未实现实时设置面板、移动显示器后自动调整密度以及目标帧率控制。以下远程模式的控制并不表示支持浏览器功能。两种模式均拒绝渲染器 `auto`、显式 `--fps`、渲染器资源及其环境覆盖、自定义 `--wv-bin`、现代 View 配置、V8、原生绘制表面和软件模式，启动前均不启用观察器。默认的 `auto + remote` 行为保持不变。每次原始运行都会保留自己的 `runs/<runId>/browser-dev-summary.json`，因此连续启动可重用输出根目录而不会覆盖证据。在停止时请保持原始预览窗口打开；刷新或崩溃接管功能未实现。详情请参见 [浏览器开发](../../docs/dual-renderer/browser-dev-loop.md)。

Browser 面板分别报告 Worker/runtime 和渲染器。Skia 的 `submitted` 回执描述一次有界的本地 WebGL2 图像提交；`accepted` 还要求匹配当前调度器证明、逻辑表面、页面和视口。诊断不授予输入权限。硬件身份保持 `unknown`，GPU 完成状态为 `not-waited`：普通提交不会等待物理 GPU 完成。已有 DOM 开发证据不能验证新的 Skia CLI 路径；实际冒烟、硬件和性能结果仍需独立验收证据。

原生 WebView（`desktop|both`），以及使用 `--software` 的 `webview` 仍明确失败。DOM SelectorQuery 有一个明确协商的有限实现，等待原生/浏览器验证；远程初始启动仍不支持。DOM 相交/滚动命令适配器以及部分 CSS/组件仍不支持。参见 [查询限制](../../docs/dual-renderer/browser-selector-queries.md)。重新加载预检验证 IR 和资源；稍后的仅浏览器准备失败会保留之前图像，并暂停已失效的输入。它不会回滚任意 JS 效果，也不会承诺实时清单回滚。参见 [事务边界](../../docs/dual-renderer/browser-presentation.md) 以及 `docs/dual-renderer/` 中的冻结目标检查清单。

<a id="web-resolution-and-presentation"></a>
### 网页解析和呈现

设置面板将逻辑视口、实际像素密度、CSS 缩放和目标/实际帧率分开。默认值为 375×667 逻辑像素，浏览器 DPR 自动设置上限为 2×，帧率 60 FPS，且自动适应窗口大小。可选择 1/1.5/2/3/4× 的密度，15/30/60/120 FPS，逻辑宽高或方向，以及适应/25%–200% 缩放。`--viewport`、`--render-scale auto|1|1.5|2|3|4` 和 `--fps` 会覆盖保存在 `.weapp-container/presentation.json` 文件中的项目偏好设置；缺少的值将使用默认值。只有 `dev` 会读取该被忽略的文件。浏览器缩放设置存储在浏览器本地；确定性的 `run`/`dispatch` 输入保持独立。

密度对已提交的树进行重采样，而无需重启 JS 或重新评估有状态的 WXS/现代 View 函数。逻辑尺寸调整使用运行时的尺寸边界；命中检测、rpx 和输入阈值保持逻辑性。密度不会重写模拟设备的 `pixelRatio`。目标使用向上取整（logical × scale）值，每边最多 4096 像素，RGBA 存储最多 16 MiB。不支持的后端、无效分配和超预算变更会明确失败，同时保留之前已验收的设置/帧。面板报告真实的帧尺寸以及渲染/传输/解码/呈现时长；目标帧率不是验收声明，也不是反复渲染空闲页面的理由。

纯滚动会重用已评估的树。事件计数保持其公共的 `ViewState.revision`，而自动模板工作则使用 `template_revision` 来处理页面/组件的数据、属性和导航变更。滚动处理程序的 `setData` 仍会使其模板失效。客户端会合并那些已被飞行响应满足的帧通知，并在每 250 毫秒更新一次指标 HUD，同时保留每个帧的内部测量值。

`GET /api/frame` 返回 `application/vnd.weapp.frame.v1`：一个小端 u32
UTF-8 JSON 元数据长度，元数据，然后是紧密打包的直alpha RGBA8。
元数据包括 `schemaVersion`、`sessionId`、`frameId`、`configGeneration`，
逻辑/物理尺寸，步长，字节长度，以及测量的绘制/读回耗时 `renderMs`。`frameId` 是会话传输序列；`sourceFrameId` 保留原生 ID，`renderRevision` 在滚动/密度重绘制时递增，无需新的源帧 ID。源 Skia 预乘 alpha 仅转换一次；零 alpha 的 RGB 被清空。客户端共享不可变的编码缓冲区，而 `/api/snapshot` 仅在需要时对原始预乘 JSON 进行编码。SSE 仅保留小帧元数据。旧客户端体以及源/呈现缓冲区共享 64 MiB 的缓存预算，包括过渡容量；慢客户端无法无限增长内存。非阻塞套接字就绪推进有界写入，无需每 256 KiB 固定等待 16 ms。

`GET /api/presentation` 返回包含 `revision`、`generation`、`logicalWidth`、`logicalHeight`、`renderScale`、`effectiveScale` 和 `fps` 的 v1 配置。
通过 POST 发送包含当前 `revision` 和可选的 `requestId`/`devicePixelRatio` 的补丁；HTTP 202 仅表示回执。稍后的 `presentation` SSE 事件在运行时线程应用后携带 `{requestId,ok,presentation,error?}`。返回过期的修订版本将返回 409。客户端保留一个正在传输的帧和一个最新的 RAF 候选帧，拒绝过时的会话/版本帧，并在逻辑几何发生变化时暂停旧图像输入。有关字段和预算详情，请参见 [完整 Web 协议](../../docs/simulator.md#开发态监督器)。

每个启动原子性地保留自己的运行命名空间和会话 ID。重用输出目录会保留之前版本的生成结果；并发运行拥有独立的暂存和发布路径。默认编译器将其输出写入自己的 `.build-output`，同时保留项目的普通 `dist`。同一运行内的版本号会递增。

WXSS、静态资源和安全的 WXML 渲染编辑使用原地清单替换机制，保留页面数据、存储、定时器和会话 ID。
JavaScript、JSON、路由、应用配置、组件或依赖变更会重启会话并旋转会话 ID，以拒绝过期输入。
WXS、源码/图结构变更以及文档本地别名变更也属于重启输入，即使没有自定义组件。旧的内联声明和 `.wxs` 资源会被检查为可执行输入。
打包器将 WXS 存储在独立的基于内容寻址的 `viewScripts` 图结构和模板 `wxsModules` 绑定中；这些内容不会进入 AppService 的模块加载器。源字节和图结构会被验证，内联脚本体将作为原始文本保留。一个隔离的 View 域会在原生 QuickJS/V8 构建中以整个文档批次的方式评估声明的 WXS 和 WXML。没有经过验证的模块图的旧版包将报错 `ERR_UNSUPPORTED_CAPABILITY`；缺少选定提供者的将报错 `ERR_ENGINE`。失败的候选将保留上一个运行的包。具有语法感知的静态图遍历阶段能够区分除法、正则表达式、注释和转义标识符；单独的 WXS 语言编译器将对不支持的格式报错 `ERR_UNSUPPORTED_WXS_SYNTAX`。WXML/WXS 输入必须是有效的 UTF-8。

独立的原生 QuickJS/V8 `ViewEngine` 适配器现在提供批处理执行、作用域/文档模块所有权以及超时/取消处置。运行时将它们连接到 WXML 评估。有关支持的子集、测试和剩余官方行为证据，请参见 [执行合约](../../docs/isolated-view-engine.md)；本地原生测试无法建立完整的 WXS、DevTools、GPU 或设备一致性。

对于包含组件作用域脚本模块或 `usingComponents` 声明的包，
当 WXML 编辑内容的节点形状、指令、结构模板/导入/包含或自定义组件输入发生变化时，也会重新启动。
仅文本值和内置呈现属性（`style`、`class`、`id`、`hidden`、`data-*`、`mark-*`）会被此额外指纹忽略。
自定义组件保留所有输入属性，包括使用呈现名称的属性。
缺失、新增或无法解码的模板将采用保守重启策略。
引擎没有堆回滚功能，因此这些候选必须在隔离环境中完成启动，才能替换运行中的组件堆；
完整重启将重置 JavaScript/页面状态。
构建失败或包无效时，将保留上一版本的运行并发送结构化诊断信息到 UI。

演示预览使用实时页面数据和最后一次提交的组件快照，而不会执行 JavaScript、微任务、观察者或生命周期钩子。组件从自身数据中选择命名模板时，会在文本/样式更新期间保留该上下文。在实时堆、帧或选择器索引被触及之前，会拒绝输入或拓扑结构的更改。

一旦渲染器发布一帧，`render.commit` 将确认
`committed: true`。准备钩子或回调失败将作为结构化错误处理；
新版本保持当前有效，UI 显示其诊断信息。只有在预发布阶段被拒绝才会保留旧版本。准备钩子的 `setData` 会等待下一次泵操作。直接嵌入器也会从 `Session::replace_manifest` 接收到可执行文件/配置变更的拒绝。

Web 和桌面使用相同的宿主时钟和渲染失效边界。
因此，定时器、页面事件处理器和桥接数据补丁会在不重新构建包的情况下刷新当前帧。空闲时钟不会发布新的帧或追踪信息。异步 JavaScript 错误会加入诊断/叠加流。
第一个帧使用 JavaScript 启动和 `onLoad` 之后的页面状态。成功重新加载会清除活动的叠加诊断，同时保留一个独立的版本化的 `diagnosticHistory`，位于 `/api/state` 和浏览器日志中。历史记录最多保留 256 条记录和 512 KiB 编码后的诊断信息，并明确包含总数量、丢弃和完整性的元数据。启动回调错误和定时器错误使用相同的流。桌面错误状态将持续存在，直到成功恢复。

自定义组件实例归属于运行时会话。模拟器在 `app.init` 中包含已验证的 `blobs`，允许组件在页面 `onLoad` 之前附加；组件就绪发生在首次渲染提交之后。每个实例拥有独立的数据、属性和作用域身份。通过键值协调机制保留存活的实例，并销毁已移除的实例。组件 `setData` 会失效当前帧，内部处理器在其组件实例上运行，投影槽内容保持其声明数据、组件查找和事件所有者。组件作用域选择器在不同实例间保持相等的节点 ID。纯 mustache 属性在可选的 IR `boundValues` 中保留 JSON 值，同时与现有的字符串 `attrs` 共存。

WXML 中 `<text>` 标签外部的仅换行缩进在源身份稳定后会被忽略。原始中间表示（IR）保持不变；单行空格、`<text>` 标签内的空白以及绑定生成的换行符仍保留为文本。渲染器会根据解析后的内容宽度、内边距以及行内子元素的边距/间距自动测量内容高度。因此，源格式不会增加空布局行，也不会抑制插槽的回退。

宿主还可以直接提供可选的 `app.init.blobs`。在后续的渲染提交中才提供 blobs 仅能保留旧的渲染路径，但不会在 `onLoad` 之前建立附加关系。观察到的顺序来自 DevTools `2.02.2608080` / 基础库 `3.17.3` 组件实例 oracle 在 `docs/devtools-evidence/2026-10-19-component-instance-apis-3173` 中的记录；该自动子集尚未通过该完整正式案例。组件 `pageLifetimes.show/hide` 随页面导航和 App 前台/后台可见性变化，在一个会话边界内生效。在可见页面上出现的新实例仅触发一次 show；被遮挡的页面、缓存的标签页和已销毁的实例保持隐藏状态。专用引擎批处理会绕过同名的普通方法，报告抛出钩子时不会跳过兄弟节点，并在用户代码之前消耗每次可见性尝试。两种 reLaunch 路径都会释放缓存标签页组件。保存的 `lifecycle-compare-3173` oracle 观察到标签页的往返 show/hide，但并未建立每种跨钩子顺序。没有自动组件重绘，除非有正式的运行时重绘事件。页面/组件的 `selectComponent`、`selectAllComponents` 以及嵌套的 `selectOwnerComponent` 使用实时声明树引用，包括原生优先匹配和插槽声明所有权。ID/class、子元素、后代和并集选择器为部分支持；导出、`>>>`、标签和属性模式明确不支持。固定 SDK 直接页面子组件的所有者行为未知。详情请参见 `docs/api-runtime-conformance.md` 中的证据限制。管理的 `triggerEvent` 是部分能力：会话在生命周期和输入回调之前将事件图发布给 QuickJS/V8，自定义监听器在相同的 JavaScript 执行轮次中运行，并带有本地详情身份。捕获、冒泡和组合默认关闭；组件边界和 catch 监听器绑定传播。保存的固定 SDK oracle 仅覆盖监听器别名和连字符/下划线命名。选项语义、嵌套同步发射和生命周期事件需要单独的正式差分证据。管理的组件关系和行为身份是部分支持：互为父/子和祖先/后代链接在 JavaScript 隔离内暴露实时实例。`linkChanged` 显式返回 `ERR_UNSUPPORTED_CAPABILITY`；移动和更广泛的官方一致性尚未验证。完整的属性类型规则和完整的官方 WXS/组件一致性尚未验证。

可见的溢出参与命中测试，包括零高度包装器的绝对后代。
显式溢出裁剪目前限制了输入；软件/Skia 绘图引擎尚未将后代像素裁剪到该边界。
这仍属于部分渲染支持，而非视觉溢出合规。

开发会话最多保留 1,024 条归一化的追踪记录和 8 MiB 的编码记录内容。这包括完整的保留请求/响应批次，但过大记录和较旧的历史记录会被明确省略，并通过 `traceSummary` 计数器、`complete: false` 以及报告/导出中的 `TRACE_HISTORY_TRUNCATED` 标识。浏览器会在追踪数量旁边标记被截断的历史记录。序列号和请求 ID 在被清除和重启后仍保持单调递增。`run`、`dispatch` 和 `Simulator::from_pack_dir` 方法默认保留完整证据。嵌入器可以调用 `set_trace_retention(TraceRetention::development())`；`DevConfig` 可以明确选择 `TraceRetention::Full` 以捕获证据。完整保留故意没有内存限制。这些历史记录限制并不能证明整个运行时的 RSS 或性能目标。

默认的观察器使用固定厂商的公共 `createCompilerContext` API；
适配器位于本仓库中，不会修改厂商源码。自定义的 `--wv-bin` 必须能解析一个 weapp-vite 安装，或发布 `docs/simulator.md` 中描述的版本化回执协议。仅有一个安静的输出目录并不被视为构建成功。退出时，监督器会停止其拥有的观察和打包进程树，包括包装器和编译器工作进程。
Windows 在执行前会将挂起的子进程分配给一个私有作业对象；在包装器退出后，其后代仍属于监督器。打包取消会轮询进程树终止，且在释放暂存文件前不会阻塞绘制表面循环。`DevSupervisor::shutdown()` 是一个明确且幂等的清理屏障，也被 Drop 使用。受控的命令行退出会在关闭 Web 监听器前回收观察器/读取器和打包器，然后释放桌面窗口。终端 SSE 刷新是非阻塞且尽力而为的。嵌入器应在释放自身绘制表面前调用此屏障；已停止的监督器将不再轮询或泵送运行时。

运行无头浏览器烟雾测试以验证画布像素、生命周期/提供者状态、指针驱动的`setData`、结构化的运行时错误叠加、WXSS重载后的恢复，以及共享会话的`/embed`客户端：

在首次浏览器启动之前，使用供应商声明的 Node/pnpm 版本来安装 Chromium，以满足其固定的 Playwright 依赖。仅安装 pnpm 依赖项并不能准备浏览器可执行文件：

```sh
pnpm --dir vendor/weapp-vite exec playwright install chromium
```

在也需要浏览器系统库的 Linux CI 运行器上，使用
`pnpm --dir vendor/weapp-vite exec playwright install --with-deps chromium`。
烟雾测试在软件 RGBA 绘制表面上无头运行，并保留开发模拟器的证据。

```sh
pnpm simulator:dev:browser-smoke -- \
  --engine quickjs \
  --out artifacts/simulator/browser-smoke.json \
  --screenshot artifacts/simulator/browser-smoke.png
```

此浏览器冒烟测试和 `pnpm simulator:dev:smoke` 默认都使用 `--port 0`，由操作系统分配一个空闲端口。开发 CLI 本身仍默认使用 5179。每个冒烟测试仅连接到其子进程宣布的 URL，并在 `<OS temporary directory>/weapp-simulator-smokes/simulator-smoke-*` 处创建独立的 `mkdtemp` 中转目录。它仅恢复源代码编辑并关闭其自身的浏览器、监视器和 Web 监听器，退出前保持现有开发服务。`--keep` 会保留本次运行的目录以便检查。
这两个脚本均接受 `--engine quickjs|v8`（默认：QuickJS）并构建/运行所选的提供者。使用 `--engine v8` 可明确测试 V8；构建失败和运行时 `ERR_ENGINE` 响应被视为失败，而非静默降级。

无头默认构建包含 QuickJS 和 Skia CPU 帧缓冲。开发桌面模式在 macOS 上使用 Metal，并需要 `desktop-window`。其他桌面 GPU 驱动器明确不可用。选择 `--software` 可获得 `winit + softbuffer` 开发绘制表面；它属于独立的软件证据。

```sh
cargo run -p container-simulator \
  --features quickjs-native,desktop-window -- \
  dev --project examples/apps/reference-app --surface desktop
```

在 Web 和桌面之间共享一个监督器和运行时会话：

```sh
cargo run -p container-simulator --features desktop-window -- \
  dev --project examples/apps/reference-app --surface both
```

编译一个呈现器并不构成实际 GPU、官方 DevTools、模拟器或物理设备的证据。每个边界都有独立的运行门禁。

桌面事件循环将指针移动/按下、滚轮以及键盘按下/松开事件批量合并，使用与 Web 共享的 `event.batch` 通道。左键松开会发出与小程序兼容的 `tap` 事件；其他按键会发出指针抬起事件。键盘事件携带物理键码、逻辑键、重复/文本和修饰键状态，并指向最后提交的渲染帧根节点，因为键盘事件没有指针坐标。逻辑视口保持固定：调整大小时会裁剪或填充物理缓冲区，比例为 1:1 像素。使用 `--viewport` 指定其初始大小；调整大小不会改变运行时布局，也不会发送组件调整大小的生命周期事件。

使用 `--engine v8` 且构建时启用了可选的 `v8-native` 特性。
如果请求的原生提供程序未编译，会话构造将明确抛出 `ERR_ENGINE` 错误边界；模拟器不会静默地切换到其他引擎。

<a id="embedding-api"></a>
## 嵌入 API

一个应用宿主可以直接使用稳定的 Rust 边界：

```rust,no_run
use container_simulator::{Simulator, SimulatorConfig};

let mut simulator = Simulator::from_pack_dir("artifacts/reference", SimulatorConfig::default())?;
let report = simulator.run()?;
let response = simulator.dispatch_json(r#"{
  "protocolVersion":"1.0", "sessionId":"simulator-1",
  "requestId":"set-data", "kind":"request", "op":"data.patch.batch",
  "payload":{"patches":[]}
}"#)?;
# let _ = (report, response);
# Ok::<(), container_simulator::SimulatorError>(())
```

`HostSession` 仍然是运行时状态的唯一拥有者。`Simulator` 仅拥有包数据块、请求排序和归一化追踪，因此 Android、iOS、Harmony、桌面和 Web 示例可以使用相同的启动和分发合约。

[Rust 应用示例](../../examples/apps/embed-runner/README.md) 使用一个 pack 目录。[Web 示例](../../examples/hosts/web/README.md) 通过 `/embed` 共享开发监督者的验证 pack/会话。原生示例有独立的资源入口点：Android 加载 `app/src/main/assets/portable-pack`，Harmony 加载 `entry/src/main/resources/rawfile`；其 README 文件描述了 pack 同步命令。iOS Swift Package 和 UIKit `ios-app` 的烟雾测试仍使用内联固定数据，因此业务应用必须提供 bundle manifest/module/blob 的加载。有关确切路径，请参见[宿主入口点](../../docs/simulator.md#app-植入边界)。

默认的 Android 原生构建没有 QuickJS 提供者。它会验证包并提交模块字节，然后在执行时返回明确的 `ERR_ENGINE`。在该环境中运行真正的小程序仍需要可用的 Android 引擎构建和独立的设备验证；仅凭包或绘制表面的烟雾测试无法证明具备该能力。

长时间运行的嵌入式宿主从其事件循环中调用 `Simulator::pump(now_ns)`，使用 Unix 时间（以纳秒为单位）。当可见页面或其数据版本发生变化时，它会处理定时器并发出一帧渲染批次；在空闲或应用卸载后，它将返回空批次。开发绘制表面已经执行了此泵操作。
